# Proposal: rebuild-contact-bot

## Why

现有单文件实现（`TG_Chat_Bot-D1.js`，约 1900 行）为解决并发问题引入了大量补偿机制：D1 条件 UPDATE 抢锁、sleep 轮询指数退避、锁过期兜底、isolate 级内存缓存与 `fresh=true` 绕缓存直读、概率触发的表清理（`now % 97 === 7`）。这些机制彼此纠缠，是历史上"话题重复创建""面板显示过期状态""系统忙请重试"等问题的根源。

本次全新重写（不兼容旧表、不迁移数据），保留产品核心能力与"单文件 Dashboard 粘贴"的部署形态，把并发处理收敛为最小原子占位 + Telegram 原生重投，删除全部锁协议、轮询与缓存补丁。

## What Changes

- **BREAKING** 整体重写：废弃现有 `TG_Chat_Bot-D1.js`，交付全新单文件 `worker.js`（内部按节组织）；部署方式保持不变——Cloudflare Dashboard 粘贴 + 绑定 D1 + 环境变量，自动建表，新增一步"配置 Cron 触发器"。
- **BREAKING** 并发模型重构（经查证 Durable Objects 的 class 创建必须 `wrangler deploy`，与 Dashboard 单文件粘贴的交付约束冲突，故采用纯 Workers + D1 的无锁协议）：
  - 话题创建：一条原子条件 UPDATE 占位（无锁释放协议、无 stale 轮询协商）；未抢到占位的请求不 sleep 轮询，返回 500 借 Telegram 原生重投退避稍后重来，届时话题已就绪。
  - 共享话题（黑名单）创建同样原子占位；未抢到者本次卡片操作延后补偿，不轮询。
  - webhook 由"先 200 再异步处理"改为"同步处理完再响应"：update 去重标记在成功处理后写入，失败自然由 Telegram 重投。
  - 删除跨请求内存缓存 `CACHE` 与全部 `fresh=true` 补丁：配置仅做请求内 memoize，面板与行为永远基于 D1 真值。
  - 表清理由概率触发（`now % 97 === 7`）改为 Cron Trigger 定时任务（`scheduled` handler）。
  - 删除：抢锁-轮询-释放协议、`TOPIC_LOCK_*` 常量、isolate 缓存及其失效补丁。
- **BREAKING** D1 全新 schema：新建数据库；`users` 表字段拉平重设计（废弃 `user_info_json` 大杂烩与锁列）、`config`、`processed_updates`、`ratelimits` 四表；删除只写不读的 `messages` 表。旧库不复用、不迁移、不触碰。
- 验证系统保留三模态热切换：人机验证支持 Cloudflare Turnstile / Google reCAPTCHA 两种验证码，可在面板轮换（Cloudflare → Google → 关闭）；自定义问答升级为**题库多题随机抽取**（旧版单题），独立开关、可与验证码串联。
- 保留核心功能：用户↔群组话题双向中继、用户资料卡、屏蔽关键字（计数+自动封禁）、关键词自动回复、转发类型过滤（7 类开关）、手动屏蔽/解封与黑名单话题、营业状态自动回复、内联按钮管理面板、用户备注。
- 移除非核心功能：未读聚合收件箱（Telegram 论坛原生未读标记已覆盖"谁有新消息"，聚合卡片的维护复杂度不匹配其增量价值）、备份群转发、协管系统（`authorized_admins`，多管理员由 `ADMIN_IDS` 环境变量承担）、消息存档。
- 备注输入改为话题内命令（`/note <内容>`），移除基于 config 表的跨 isolate 管理员状态机。

## Capabilities

### New Capabilities

- `topic-relay`: 用户私聊消息中继到管理群专属话题（话题即用户标识），管理员在话题内回复自动转回用户；含无锁话题创建、话题失效自动重建、置顶资料卡、按消息类型的转发过滤。
- `user-verification`: 首次联系用户须通过验证才能发消息：人机验证（Cloudflare Turnstile / Google reCAPTCHA 可切换，Mini App + initData 验签 + nonce）与自定义问答题库（多题随机抽取），两者可独立开关、可串联。
- `keyword-filter`: 消息文本命中屏蔽关键字时拦截不转发并累计违规次数，达到阈值自动封禁；关键词自动回复共用同一匹配引擎。
- `moderation`: 管理员手动屏蔽/解封用户（资料卡按钮与黑名单话题卡片双向同步），强制重置用户验证状态。
- `admin-panel`: 主管理员私聊 `/start` 打开内联按钮配置面板：验证开关与问答题库管理、欢迎语、屏蔽词与自动回复规则管理、营业状态切换、黑名单话题手动重置。

### Modified Capabilities

（无——`openspec/specs/` 下无既有规格，本项目为首次建立规格。）

## Impact

- **代码**：全新单文件 `worker.js`（内部分节：常量/DB/TG API/验证/中继/面板/清理，导出 `fetch` + `scheduled`），替换旧 `TG_Chat_Bot-D1.js`（git 历史保留）；README 部署文档更新。
- **Cloudflare 资源**：**新建一个 D1 数据库**（旧库不复用、不迁移、不触碰），绑定名沿用 `TG_BOT_DB`；新增一个 Cron Trigger（表清理定时任务）。不引入 Durable Objects、不需要 wrangler。
- **环境变量**：沿用旧版全部 9 个：`BOT_TOKEN`、`ADMIN_IDS`、`ADMIN_GROUP_ID`、`WORKER_URL`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`、`RECAPTCHA_SITE_KEY`、`RECAPTCHA_SECRET_KEY`、`TELEGRAM_WEBHOOK_SECRET`。
- **部署方式**：与旧版一致——Dashboard 粘贴单文件、绑定 D1、填环境变量、setWebhook；仅新增"设置 → 触发器 → 添加 Cron"一步。
- **数据**：旧 D1 表不迁移。已验证用户需重新验证，已有话题映射失效（用户下次发消息会新建话题）。
