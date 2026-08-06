# Design: rebuild-contact-bot

## Context

动机见 proposal.md（Why）。设计约束：

- **交付形态是硬约束**：单个 `worker.js`，用户手动在 Cloudflare Dashboard 粘贴部署（与旧版一致）。经查证，Durable Objects 的 class 创建/删除等 lifecycle 变更只能通过 `wrangler deploy` 应用，Dashboard 编辑器无法完成——因此 DO 方案被此约束排除，并发设计必须在纯 Workers + D1 内解决。
- Cloudflare Workers 多 isolate 并发、无共享内存：任何跨请求的"读-判-写"都可能与其他 isolate 交错；isolate 内存不可作为一致性依据。
- Telegram webhook 特性：不同 chat 的 update 并发投递；响应非 2xx 时 Telegram 会对该 update 按指数退避自动重投（持续数小时）；同一 update 的重试是串行的（等上次响应后才重试）。这是一个可借用的免费重试队列。
- 免费计划可运行：Workers 免费版 CPU 限额 10ms/请求（IO 等待不计入），D1 免费额度每天 500 万行读 / 10 万行写；Cron Triggers 免费可用。
- 全新代码库、全新 D1 数据库，无旧表兼容负担；行为需求以本 change 的 5 个 spec 为准。

## Goals / Non-Goals

**Goals:**

- 并发正确性只依赖两样东西：D1 单条语句的原子性 + Telegram 的串行重投。代码中不出现锁释放协议、sleep 轮询、跨请求内存缓存、概率清理。
- 单一数据源：业务状态只存 D1；任何界面（面板）渲染的都是持久化真值。
- 交付单文件、Dashboard 粘贴即用：自动建表，除 Cron Trigger 外零新增部署步骤。
- 单文件内部按节组织，每节职责单一、可独立理解。

**Non-Goals:**

- 旧 D1 数据迁移（用户已明确不需要）。
- wrangler / CI 部署路径（不排斥，但不是设计目标，文档不覆盖）。
- 高吞吐水平扩展：目标是单 bot 客服量级（每天 ≤ 数万条消息）。
- 消灭并发建话题窗口内"输家"消息的秒级延迟（重投机制的固有代价，可接受）。

## Decisions

### D1. 并发模型：最小原子占位 + Telegram 原生重投

处理模型先行：webhook 入口**同步处理完再响应**（旧版是先回 200 再 `waitUntil` 异步跑）。响应码于是成为控制流：`200` = 处理完毕；`500` = 请求 Telegram 稍后重投本 update。

```
Telegram webhook ──► fetch（同步处理）
   │
   ├─ 已处理过该 update_id？ ──► 200（去重）
   ├─ 处理成功 ──► 写去重标记 ──► 200
   └─ 话题未就绪 / 瞬时失败 ──► 不写标记 ──► 500 ──► Telegram 按退避重投
```

**用户专属话题创建协议**（用户行 `topic_id` 为空时）：

1. 原子占位（一条 SQL，无锁释放协议）：
   `UPDATE users SET topic_claim_ts=:now WHERE user_id=:uid AND topic_id IS NULL AND (topic_claim_ts IS NULL OR topic_claim_ts < :now - 30000)`
2. `changes=1`（抢到）：`createForumTopic` → 写入 `topic_id` 并清 `topic_claim_ts` → 发置顶资料卡 → 继续转发本条消息。API 失败则尽力清占位并返回 500（重投时重试；即使清不掉，30 秒 stale 后可被接管）。
3. `changes=0`（没抢到）：重读一次 `topic_id`；已有值则直接转发；仍为空则返回 500——**不轮询、不 sleep**，等待完全外包给 Telegram 的重投退避，重投到达时话题通常已就绪。

**共享话题**（黑名单）：`INSERT OR IGNORE` 保证 config 行存在后，同样一条条件 UPDATE 占位（空值或 stale 占位可抢）。抢到者创建话题写回 id；没抢到者重读一次，拿到 id 就用，拿不到就**跳过本次卡片操作**——卡片是尽力而为的辅助路径，屏蔽状态本身即时生效，卡片由后续操作补偿（spec 已为此留出契约余地）。

**去重**：入口 `SELECT` 查 `processed_updates`，命中直接 200；成功处理后 `INSERT OR IGNORE` 写标记。写标记放在成功之后是安全的：Telegram 对同一 update 的重试串行，不存在同一 update 并发在途。

**限流**：沿用旧版 `ratelimits` 桶计数（`INSERT ... ON CONFLICT ... RETURNING`，本就是原子的、设计合理的部分），清理改由 Cron 负责。

备选方案对比：

| 方案 | 并发正确性 | 复杂度 | Dashboard 单文件粘贴 | 结论 |
|------|-----------|--------|---------------------|------|
| D1 抢锁 + sleep 轮询 + 释放协议（现状） | 依赖多步锁协议，边界多 | 高 | ✓ | 弃：本次要移除的 |
| per-user Durable Object 串行化 | 结构性保证 | 中 | ✗ class 创建必须 wrangler | 被交付约束排除 |
| 原子占位 + Telegram 重投 | 占位一条 SQL；重试外包给 TG | 低 | ✓ | ✅ 采用 |
| Cloudflare Queues 串行消费 | 保证 | 中 | ✗ 付费 + wrangler | 弃 |

### D2. 数据归属：D1 唯一数据源，零跨请求缓存

- 业务状态（用户档案、状态机、话题映射、配置、去重、限流）全部在 D1；`wrangler d1 execute` 或 Dashboard 控制台可直接查询运维。
- 跨请求内存缓存整体删除。config 表一次 `SELECT *` 即全量（约二十行），每次 update 处理开始读一次、**请求内 memoize**。旧版"缓存 + 到处 `fresh=true` 打补丁"的补丁网彻底消失，面板与行为永远一致。
- 用量核算：单条 update 约 20-30 行读、2-5 行写；日均 1 万条消息 ≈ 30 万行读 / 5 万行写，均在免费额度内（500 万读 / 10 万写）。

### D3. D1 schema（全新四表，自动建表）

```sql
CREATE TABLE IF NOT EXISTS users (
  user_id            TEXT PRIMARY KEY,
  state              TEXT NOT NULL DEFAULT 'new',  -- new | captcha_pending | qa_pending | verified
  is_blocked         INTEGER NOT NULL DEFAULT 0,
  strike_count       INTEGER NOT NULL DEFAULT 0,   -- 屏蔽词违规计数
  topic_id           INTEGER,                      -- 专属话题；NULL=未创建
  topic_claim_ts     INTEGER,                      -- 话题创建占位时间戳；NULL=无人在建
  name               TEXT,
  username           TEXT,
  note               TEXT,
  verify_nonce       TEXT,
  nonce_issued_at    INTEGER,
  qa_question_id     TEXT,                         -- 当前抽中的问答题 id；NULL=无待答题
  card_msg_id        INTEGER,                      -- 置顶资料卡
  blacklist_msg_id   INTEGER,                      -- 黑名单卡片
  last_busy_reply_at INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_topic ON users(topic_id) WHERE topic_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS processed_updates (update_id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_processed_ts ON processed_updates(ts);

CREATE TABLE IF NOT EXISTS ratelimits (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ratelimits_ts ON ratelimits(ts);
```

对比旧 schema：`user_info_json` 大杂烩拉平为显式列（可 SQL 查询、无 JSON merge 竞争）；锁列 `topic_creating/topic_create_ts` 替换为单一 `topic_claim_ts`（占位即语义，无配套协议）；删除只写不读的 `messages` 表。`idx_users_topic` 唯一索引兼作管理员回复的话题→用户反查。建表走启动时 `CREATE TABLE IF NOT EXISTS`（Dashboard 部署无 migrations 可用），`scheduled` handler 亦兜底调用。面板输入态沿用 config 表 `admin_state:<id>` 键（低频、单管理员写，无并发问题）。

### D4. 验证：双模态验证码 + 问答，nonce 一次性

- 验证码双模态：配置 `captcha_mode ∈ {turnstile, recaptcha}` + `enable_captcha` 开关，面板以三态轮换呈现（Cloudflare → Google → 关闭）；验证页与 siteverify 按模式分发（Turnstile JSON 接口 / reCAPTCHA form 接口），`enable_qa` 独立。
- `/submit_token` 流程：先做 initData HMAC 验签（纯 CPU，失败即 400，不产生任何存储读写）→ 以验签得到的 uid 做 `ratelimits` 限流 → 校验 nonce（一次性，校验后立即作废）→ 当前模式 siteverify → 推进状态机。
- 问答题库：config 存 `qa_questions` JSON 数组（`[{id, q, a}]`，id 为添加时间戳）。进入 `qa_pending` 时随机抽一题，把题目 id 写入 `users.qa_question_id`，判定只比对该题答案（防"背一题答案通吃"）；答错或该题已被删除时重新抽题写回（题库多于一题时自然换题，抬高脚本枚举成本）。题库为空时该环节自动跳过，面板显著提示。
- 状态机：`new → captcha_pending → qa_pending → verified`，开关关闭的环节被跳过；全关时 /start 直接 `verified`。

### D5. 关键词匹配：默认子串，`re:` 前缀显式正则

旧版把所有屏蔽词按正则执行，普通词也承担 ReDoS 面。新规则：条目默认小写子串匹配；仅 `re:` 前缀条目走正则，并保留旧版防护思路（模式长度 ≤ 256、危险形态黑名单拒绝、被检文本截断 512 字符、异常吞掉视为不匹配）。自动回复规则同引擎。

消息类型过滤沿用旧版检查链语义：按"转发 > 语音/音频 > 贴纸/GIF > 媒体 > 链接 > 纯文本"顺序取首个命中类型查其开关，频道来源转发单独判定（行为契约见 topic-relay spec）。

### D6. 单文件组织（分节）

```
worker.js  (export default { fetch, scheduled })
├─ §1  常量与默认配置（DEFAULTS、限流/占位/TTL 参数）
├─ §2  入口路由：webhook 秘钥校验、GET /verify、POST /submit_token、update 分发
├─ §3  D1 访问层：users CRUD（显式列）、config 读写（请求内 memoize）、自动建表
├─ §4  Telegram API 客户端：429 按 retry_after / 5xx 指数退避、总等待封顶 10s
├─ §5  安全原语：常量时间比较、initData 验签、nonce
├─ §6  验证流：状态机、双模态 siteverify、问答比对
├─ §7  过滤引擎：关键词（子串 + re:）、消息类型判定链
├─ §8  消息中继：话题占位协议、forward/copy 降级、送达 reaction、话题失效恢复
├─ §9  卡片：资料卡 / 黑名单卡构造与同步
├─ §10 管理群处理：话题回复转达、/note、屏蔽/解封回调
├─ §11 管理面板：渲染、回调分发、输入态
└─ §12 验证页 HTML 模板（按 captcha_mode 渲染） + scheduled 清理任务
```

节内只向上依赖（§8 可用 §3/§4，不反向），保持单文件里的模块边界纪律。

### D7. 部署：Dashboard 粘贴 + Cron Trigger

- 部署步骤与旧版一致：新建 D1 数据库（**全新库，不复用旧库**，用户已确认）→ 创建 Worker → 粘贴 `worker.js` → 绑定 `TG_BOT_DB` → 填 9 个环境变量 → `setWebhook`。
- 新增一步：Worker 设置 → 触发器 → 添加 Cron（建议每小时），驱动 `scheduled` handler 清理 `processed_updates`（保留 7 天）与 `ratelimits`（保留 10 分钟），替代旧版散布各处的概率触发清理。
- 自动建表保留（旧版卖点）：`fetch` 冷启动与 `scheduled` 均执行 `CREATE TABLE IF NOT EXISTS`。

### D8. 话题失效分类处理（删除 ≠ 关闭 ≠ 临时错误）

发消息到话题（用户专属或共享）失败时按错误精确分类，三种处理路径：

| 错误 | 含义 | 处理 |
|------|------|------|
| `message thread not found` / `TOPIC_DELETED` | 话题已被删除 | 清存储的话题 ID（用户话题清映射、共享话题清 config 值），下次需要时自动重建 |
| `TOPIC_CLOSED` | 话题被关闭 | 调 `reopenForumTopic` 自动重开并重试发送一次；重开失败（权限不足等）降级按"已删除"处理 |
| 其他（429 限流、网络、权限） | 临时故障 | 不动话题 ID——避免旧版"临时错误→清空→重建循环"导致的话题堆积 |

旧版缺陷记录：旧代码错误匹配串未覆盖 `TOPIC_CLOSED`，话题被关闭后用户消息转发会静默失败直到人工重开。`reopenForumTopic` 所需的 `can_manage_topics` 权限与 `createForumTopic` 相同，不引入新的权限要求。面板另设"重置黑名单话题"手动兜底（见 admin-panel spec）。

## Risks / Trade-offs

- [500 重投路径把等待交给 Telegram：并发首消息中"没抢到占位"的消息会延迟数秒（TG 退避节奏）才出现在话题里] → 仅影响并发建话题的窄窗口；用户侧无感（消息已发出）；TG 重投持续数小时足够覆盖；占位 30s stale 保证占位者挂死后可被接管。
- [同步处理拉长 webhook 响应时间，接近 Telegram 超时会引发额外重投与重复处理] → 处理链中 TG API 重试总等待封顶 10s，远低于超时阈值；且成功即写去重标记，迟到的重投被标记拦截，重复处理不外化为重复转发。
- [Cron Trigger 漏配：清理不跑，processed_updates/ratelimits 持续增长] → README 将其列为必做步骤并说明后果；行体积小（每 update 一行），D1 免费 5GB 下即使漏配也是慢性而非急性问题；scheduled 同时兜底建表，配置后自愈。
- [重写回归：旧代码累积的边角修复（话题删除的精确错误匹配、HTML 转义防面板静默失灵、临时 API 错误不得触发共享话题重建等）在重写中遗漏] → 这些行为已显式写入 specs 作为 scenario，tasks 按 scenario 逐项验收。
- [不迁移数据：存量用户需重新验证，旧话题失联、同一用户将出现新话题] → 用户已明确接受；README 明示，旧话题可手动删除或保留存档。
- [单文件无模块边界，长期可维护性弱于多文件] → 交付形态是用户明确约束；以分节注释 + 节间单向依赖 + 纯函数纪律弥补；行数目标控制在旧版量级内。
- [无跨请求缓存后每 update 恒定多一次 config 全量读] → 用量核算见 D2，免费额度余量 15 倍以上；这是用一致性换缓存补丁网的有意取舍。

## Migration Plan

1. Dashboard 新建 D1 数据库（新名字，旧库不动）。
2. 创建新 Worker（或复用旧 Worker 名），粘贴新 `worker.js`，部署。
3. 绑定 D1（变量名 `TG_BOT_DB`）、填 9 个环境变量。
4. 设置 → 触发器 → 添加 Cron Trigger（每小时）。
5. `setWebhook` 指向 Worker URL（沿用同一 `TELEGRAM_WEBHOOK_SECRET`）。
6. 冒烟验收：新用户验证流（双模态各一次）→ 话题创建 → 双向回复 → 屏蔽词 → 类型过滤 → 面板。
7. 稳定后删除仓库中旧单文件；旧 Worker/旧库保留一段时间作回滚点。

回滚：把旧单文件重新粘贴回 Worker（或 `setWebhook` 指回旧 Worker），旧库数据全程未被触碰。

## Open Questions

- 欢迎语媒体存储沿用 `{type, file_id, caption}` JSON 约定还是拆列：面板与发送逻辑内聚，实现时定，不影响外部行为。
