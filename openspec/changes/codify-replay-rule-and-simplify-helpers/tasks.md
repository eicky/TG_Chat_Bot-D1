## 1. 集中重放约定（零代码风险，先做以为后续提供语境）

- [x] 1.1 在 `processUpdate`（worker.js:160-165 注释块）追加一行可引用约定：claim 只防并发重复处理、不防重投重放；不可逆副作用 MUST 排在最后一个抛错点之后，或把幂等键绑定到 `update_id`
- [x] 1.2 在 `entryId`（worker.js:2178）、`sendWelcomeOnce`（worker.js:1451）头注释各加一句 `// 见 processUpdate 的重放约定` 反向引用
- [x] 1.3 在列表追加 `appendOnce` 调用点（qa_add 2138-2140、ar_add 2166 附近）与话题 claim/fencing 路径的注释补同一反向引用

## 2. 简化 `entryId`（worker.js:2185-2187）

- [x] 2.1 删除 `c.updateId` 的 null/undefined 判断与 `genNonce` 回退，函数体改为 `return \`u${c.updateId}\`;`
- [x] 2.2 删除注释（worker.js:2183）中"无 update 上下文（理论上不会发生，防御性）时退回随机 id"一句，保留 update_id 绑定与重放去重的说明
- [x] 2.3 grep 确认 `genNonce` 仍有 ≥1 处使用，无孤儿

## 3. 简化 `sendWelcomeOnce`（worker.js:1462-1477）

- [x] 3.1 删除 `key = ... ? null : String(...)` 三元与 `if (key !== null)` 守卫，改为 `const key = String(c.updateId);`
- [x] 3.2 `uid` 内联为 `user.user_id`，压平一层缩进；保留 `if (!claimed) return` 注释
- [x] 3.3 不改 `String()` 包裹——见 design 的亲和分析（TEXT 列使其技术冗余但语义自解释）

## 4. 简化 `syncBlacklistCard`（worker.js:1911-1944）

- [x] 4.1 抽 `base = { chat_id, text, parse_mode, link_preview_options, reply_markup }`
- [x] 4.2 `editMessageText` 改为 `{ ...base, message_id: user.blacklist_msg_id }`
- [x] 4.3 `sendMessage` 改为 `{ ...base, message_thread_id: topicId }`
- [x] 4.4 确认 editMessageText 分支的 `if (edited !== null) return` 与 sendMessage 的 try/catch 保持原样

## 5. 去重 `sentTo`（smoke-test.mjs:230-234）

- [x] 5.1 把 `sentTo` 重定义为 `(chatId, needle) => countSentTo(chatId, needle) > 0`，删除其逐字重复的三条件谓词
- [x] 5.2 确认 `countSentTo` 定义在前、`sentTo` 在后投影；所有 `sentTo(...)` 调用点语义不变（含 `!sentTo(...)` 否定用法）

## 6. 验证

- [x] 6.1 跑全量 `smoke-test.mjs`，确认全部断言原样通过（无增删断言）
- [x] 6.2 `openspec validate codify-replay-rule-and-simplify-helpers` 通过（本变更无 spec delta，若校验要求 spec 变更则记录为工具约束、不伪造要求）
- [x] 6.3 人工 diff 确认四处改动均为行为保持：无控制流分支增减、无数据流变化、无断言增删
