## Why

`harden-retry-concurrency-and-admin-flows` 重写引入了四处重放幂等助手（`entryId`、`sendWelcomeOnce`、`syncBlacklistCard` 的双发卡片、`smoke-test.mjs` 的 `sentTo`/`countSentTo` 谓词），它们各自携带冗余：死防御分支、重复字段、逐字重复的过滤谓词。这些冗余不影响行为，但让"代码相信什么"与"代码实际保证什么"不一致——例如 `entryId` 的 `genNonce` 回退在它声称防御的那条不可达路径上反而会破坏 `appendOnce` 的去重（每次产生新随机 id）。

同一份重写还引入了一条贯穿四个函数的实现约定——"claim 只防并发重复处理、不防重投重放，故不可逆副作用要么排在最后一个抛错点之后，要么把幂等键绑定到 `update_id`"——但它只散落在四个函数头注释里，彼此不引用。后续每来一个新的副作用场景，维护者要从某个函数注释里重新发现这条规则。

本变更**保持一切外部行为不变**，只做两件事：删除四处死代码与重复，并把那条散落的实现约定集中到一个可发现的锚点。

## What Changes

- **集中注释重放约定**：在 `processUpdate`（worker.js:160-165 已有的 claim/副作用顺序注释处）追加一行可引用的编码约定，说明 claim 不防重投、不可逆副作用的两种安全排布方式；并在四个相关函数（`entryId`、`sendWelcomeOnce`、列表追加与话题 claim 路径）头注释加一句指向该约定的反向引用。
- **`entryId`（worker.js:2185-2187）**：删除 `c.updateId` 的 null/undefined 判断与 `genNonce` 回退，连同注释中"退回随机 id"一句。`c.updateId` 由 `processUpdate` 的单一入口结构性保证非空（`dispatch` 全文件唯一调用点）。
- **`sendWelcomeOnce`（worker.js:1462-1477）**：删除 `key !== null` 守卫与一层缩进；保留 `key = String(c.updateId)`（承载显式的存文本语义，query 内复用）；`uid` 内联为 `user.user_id`。
- **`syncBlacklistCard`（worker.js:1911-1944）**：把 `editMessageText` 与 `sendMessage` 共享的 5 个字段（`chat_id`、`text`、`parse_mode`、`link_preview_options`、`reply_markup`）抽成 `base`，两处各自只展开差异字段（`message_id` / `message_thread_id`）。
- **`smoke-test.mjs`（230-234）**：把 `sentTo` 重定义为 `countSentTo` 的布尔投影 `(id, n) => countSentTo(id, n) > 0`，三条件过滤谓词只在一处定义。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。重放幂等与消息不重复转发的**行为要求**已存在于 `topic-relay` 的"Update 幂等处理"要求（spec.md:5-24）及限流、话题 fencing 等相关要求中；本变更不改变任何可观察行为，故不产生 spec delta。集中注释记录的是**实现约定**（如何达成既有要求），属 design 层，不进规格。

## Impact

- **代码**：`worker.js`（3 处简化 + 注释）、`smoke-test.mjs`（1 处谓词去重）。纯重构与注释，无控制流或数据流变化。
- **数据库**：无变化。`welcome_update_id` 仍存文本（见 design 的亲和分析）。
- **测试**：`smoke-test.mjs` 自身被简化，但不增删断言；全量冒烟测试应原样通过。
- **规格**：无变化。
- **风险**：bounded——见 design 的逐项风险与缓解。

## Non-goals

- 不合并 `sendWelcomeOnce` 进 `admitInbound`：那会把欢迎语专属判断泄漏进通用准入管线（layering 违规），多一次 D1 往返是分层正确的代价。
- 不统一 `kw_add`（`undefined`）与 `qa/ar`（`list`）的返回形状：两者去重语义有意不同，统一会把"重复屏蔽词给出可见反馈"改成静默成功，与既有测试断言冲突。
- 不收敛 `smoke-test.mjs` 既有的 `tgFailNext`/`tgFailAll` 到 `tgHooks`：属既有代码，且 `d1Hook` 注入的是 D1 层而非 fetch 层，不可合并。
- 不为配置列表变更的重放幂等性新增规格要求：当前规格的副作用枚举未覆盖管理员可见的配置变更，这是一处真实但独立的缺口，留作后续变更，不在本次清理范围内（见 design 的"观察"）。
