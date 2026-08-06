# Tasks: rebuild-contact-bot

## 1. 单文件骨架与数据层

- [x] 1.1 创建 `worker.js` 骨架：分节注释结构（§1-§12）、`export default { fetch, scheduled }`、§1 常量与默认配置（DEFAULTS、限流/占位 30s/nonce TTL/清理保留期参数）
- [x] 1.2 §3 D1 访问层：自动建表（四表 + 索引，`CREATE TABLE IF NOT EXISTS`，fetch 冷启动与 scheduled 均调用）、users CRUD（显式列，无 JSON merge）、config 全量读 + 请求内 memoize、config 写
- [x] 1.3 §4 Telegram API 客户端：429 按 retry_after / 5xx 指数退避、总等待封顶 10s、`setMessageReaction` 失败静默

## 2. 安全与验证基础

- [x] 2.1 §5 安全原语：webhook secret 常量时间比较、initData HMAC-SHA256 验签（auth_date 时效）、nonce 生成/校验/作废
- [x] 2.2 §7 过滤引擎：屏蔽词默认小写子串匹配、`re:` 前缀正则（长度 ≤256、危险形态拒绝、文本截断 512、异常视为不匹配）、自动回复同引擎；覆盖 keyword-filter spec 的匹配 scenario
- [x] 2.3 §7 消息类型判定链：转发 > 语音/音频 > 贴纸/GIF > 媒体 > 链接 > 纯文本，频道来源单独判定
- [x] 2.4 §12 验证页 HTML：按 `captcha_mode` 渲染 Turnstile 或 reCAPTCHA 组件 + Telegram WebApp initData 提交，用户参数经转义嵌入
- [x] 2.5 §6 双模态 siteverify：Turnstile JSON 接口 / reCAPTCHA form 接口按模式分发

## 3. 入口与处理模型

- [x] 3.1 §2 入口路由：webhook secret 校验（403）、`GET /verify`、`POST /submit_token`、update 同步处理后响应（200/500 控制流）
- [x] 3.2 update 去重：入口 SELECT `processed_updates` 命中即 200，成功处理后 INSERT 标记；500 路径不写标记（由 Telegram 串行重投）
- [x] 3.3 用户消息限流：`ratelimits` 原子桶计数（ON CONFLICT RETURNING）、超限不转发 + 提示防抖、管理员豁免

## 4. 私聊路径：验证流与消息中继

- [x] 4.1 §6 验证状态机：`new → captcha_pending → qa_pending → verified`，开关跳过环节、全关直通、管理员豁免、`/start` 各状态行为、欢迎语（文本/媒体 + `{name}` 替换转义）
- [x] 4.2 `/submit_token` 处理：验签前置（失败零存储副作用）→ uid 限流 → nonce 一次性校验 → siteverify → 状态推进；被屏蔽用户拒绝
- [x] 4.3 问答验证：随机抽题 + `qa_question_id` 绑定当前题、答案 trim 精确比对（只认当前题）、答错/题被删重新抽题、`/` 开头输入不判错、题库为空跳过环节
- [x] 4.4 §8 中继前置检查：被屏蔽提示（防抖、/start 不解封）、屏蔽词检测→计数/警告/达阈值自动封禁、类型过滤（管理员豁免）、自动回复、忙碌提示（冷却防抖）
- [x] 4.5 §8 话题占位协议：原子条件 UPDATE 占位（30s stale 可接管）→ 抢到者 createForumTopic + 写映射 + 置顶资料卡；没抢到者重读一次，仍无则返回 500 交 Telegram 重投——无轮询无 sleep
- [x] 4.6 §8 转发执行：forward/copy 降级、送达 reaction、话题失效分类处理（删除类错误清映射重建、TOPIC_CLOSED 自动 reopen 重试一次后降级、临时错误不动映射）、编辑消息通知

## 5. 管理群路径与卡片

- [x] 5.1 §9 卡片构造：资料卡/黑名单卡（HTML 转义、备注行、按钮组）
- [x] 5.2 §10 管理员话题回复转达（copyMessage，失败话题内提示）、`/note` 命令（设置/清除 + 资料卡刷新）
- [x] 5.3 §10 屏蔽/解封回调：权限校验、状态切换 + 计数清零、资料卡按钮与黑名单卡片双向同步；黑名单共享话题原子占位创建（没抢到延后补偿）+ 失效分类处理（删除→清空重建、TOPIC_CLOSED→自动 reopen、临时错误不重建）
- [x] 5.4 `/reset <id>` 命令（管理员私聊：重置状态 + 作废 nonce、通知双方、参数校验）与管理员命令注册（setMyCommands）

## 6. 管理面板

- [x] 6.1 §11 面板框架：主菜单、回调分发、权限校验（非管理员拒绝）、渲染公共件（转义 + 截断 + 禁用链接预览）、所有值 fresh 读 D1
- [x] 6.2 验证配置页：验证码三态轮换（Cloudflare→Google→关闭）、问答开关、问答题库管理（列出/添加 `问题===答案`/逐条删除、空题库警示），切换即时重绘
- [x] 6.3 转发设置页：7 类开关可视化切换（按钮显示接收/拦截状态）
- [x] 6.4 列表管理：屏蔽词/自动回复的列出/添加/删除；输入态（config 表 `admin_state`：点击后下一条消息为值、编辑回显当前值、`/cancel` 取消）
- [x] 6.5 营业状态页：营业/休息切换、忙碌回复语编辑；欢迎语编辑（文本或媒体）
- [x] 6.6 维护操作：面板"重置黑名单话题"按钮（清空存储话题 ID，下次自动重建）

## 7. 清理任务与验收交付

- [x] 7.1 §12 `scheduled` handler：清理 `processed_updates`（7 天）与 `ratelimits`（10 分钟）、兜底建表
- [x] 7.2 `wrangler dev` 本地起服务 + `curl` 模拟 webhook：按 5 个 spec 的 scenario 逐条冒烟核对（伪造请求 403、重投去重、并发首消息单话题 + 500 重投路径、双模态验证全流程、屏蔽词计数封禁、类型过滤、面板增删改）
- [x] 7.3 更新 `README.md`：Dashboard 粘贴部署教程（新建 D1、绑定、9 个环境变量、**新增 Cron 触发器步骤**、setWebhook）、明示不迁移旧数据及回滚方式（粘回旧文件即可）
- [x] 7.4 删除旧 `TG_Chat_Bot-D1.js`（git 历史保留），`openspec validate --strict` 复查通过
