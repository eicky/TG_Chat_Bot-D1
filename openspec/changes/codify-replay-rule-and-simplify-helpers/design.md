## Context

本变更是 `harden-retry-concurrency-and-admin-flows` 重写的收尾清理，不引入新行为。重写建立的模型（webhook 同步处理 + D1 条件更新 + claim/租约 + HTTP 状态码表达重投）保持不变；其行为契约见 `topic-relay` 的"Update 幂等处理"要求。

约束（承自重写）：

- `dispatch`（worker.js:201）是 `processUpdate`（worker.js:166）的唯一下游入口；`c.updateId` 在 processUpdate 早返回（168）后于 179 行赋值。这是结构性不变量，不靠运行期约定维持。
- 单文件 Dashboard 部署、无运行时依赖的约束继续生效。

## Goals / Non-Goals

**Goals**

- 让四处助手代码"相信的内容"与"实际保证的内容"一致：删掉不可达且会误导读者的防御分支。
- 把散落在四个函数注释里的重放实现约定集中到单一锚点，使新增副作用场景时有一条可引用的规则。

**Non-Goals**（见 proposal 的 Non-goals）

## Decisions

### 1. 重放约定的锚点选 `processUpdate`，并加反向引用

约定的内容：

> claim 只防止同一 `update_id` 被**并发**重复处理；它不防止 Telegram 因 500 而**重投**整条 update、把整段逻辑从头重放。因此任何不可逆副作用 MUST 满足二者之一：(a) 排在该处理路径最后一个可能抛错的点之后；(b) 把幂等键绑定到 `update_id`，使重放时被识别为同一次。

锚点选 `processUpdate` 的 160-165 注释块（那里已有 claim/副作用顺序的说明），而非 `newCtx`（太底层、不知重放）或模块顶（离代码太远）。

**反向引用是关键**：集中注释是"规范"，四个函数注释是"样例"，二者不可互替。写新副作用函数的人会去读相似函数（如 `sendWelcomeOnce`），不会去翻入口。故每个相关函数头注释加一句 `// 见 processUpdate 的重放约定`，否则集中化反而降低局部性。

涉及反向引用的四处（按重写时确立约定时的形态）：

- `entryId`——把幂等键绑到列表条目 id（手法 b）。
- `sendWelcomeOnce`——条件 UPDATE 以 `welcome_update_id = update_id` 占位（手法 b）。
- 列表追加 `appendOnce` 的调用点——依赖 `entryId` 提供的绑定。
- 话题 claim / fencing 路径——副作用排在 claim 之后、终态之前（手法 a 的变体）。

### 2. `entryId` 删除 `genNonce` 回退

现状（worker.js:2185-2187）：

```js
function entryId(c) {
  return c.updateId !== null && c.updateId !== undefined ? `u${c.updateId}` : `r${genNonce(10)}`;
}
```

删除依据：

- **不可达**：`entryId` 仅两处调用（qa_add 2142、ar_add 2167），均在 `applyAdminInput` 内；`applyAdminInput ← handleAdminInput ← dispatch ← processUpdate`，全程经过 179 行的 `c.updateId` 赋值。
- **即便触达也是错的**：`genNonce` 每次产生新随机 id，会让 `appendOnce` 在那条路径上失去去重——即"防御"反而制造了它声称要防止的重复追加。删成 `` `u${c.updateId}` `` 后，即便（不可能地）`c.updateId` 为 `undefined`，也得 `"uundefined"` 这一稳定 id，appendOnce 仍能去重。两种都不正确，但简化版至少自洽。
- `genNonce` 删后仍被 5 处使用（514/1106/1590/1846/789），不产生孤儿。

注释 2183"无 update 上下文（理论上不会发生，防御性）时退回随机 id"一句一并删除，否则注释与代码矛盾。

### 3. `sendWelcomeOnce` 压平，保留 `String()`

现状（worker.js:1462-1477）含 `key !== null` 守卫与一层多余缩进。简化为：

```js
async function sendWelcomeOnce(c, user, from) {
  const key = String(c.updateId);
  const claimed = await dbRun(
    c,
    `UPDATE users SET welcome_update_id = ?, updated_at = ?
      WHERE user_id = ? AND (welcome_update_id IS NULL OR welcome_update_id <> ?)`,
    [key, Date.now(), user.user_id, key]
  );
  if (!claimed) return; // 本 update 已发过：重投重放，不再发第二条
  await sendWelcome(c, user.user_id, from);
}
```

**`String()` 的亲和分析（记录以免后人盲改）**：`welcome_update_id` 是 `TEXT` 列（worker.js:299）。SQLite TEXT 亲和在存入数字与比较数字时都会自动转文本，故绑定裸数字 `c.updateId` 与绑定 `String(c.updateId)` **存储和比较行为完全一致**——包括对既存文本行的 `<>` 比较（参数无亲和，列亲和施加其上）。`String()` 因此**技术上冗余**。

但保留它：显式表达"此列存文本"的意图，不依赖读者懂 SQLite 亲和规则；且在 once-per-user 的非热路径上，省一次 `String()` 不如保留可读性。`key` 同时在 query 的 SET 与 WHERE 出现，保留局部变量还避免两次 `String()` 调用与重复字面量。

`uid = user.user_id` 内联：简单属性访问，query 与 `sendWelcome` 各用一次，内联可读性不降。

### 4. `syncBlacklistCard` 抽 `base`

`editMessageText`（1919）与 `sendMessage`（1932）共享 5 字段。抽：

```js
const base = {
  chat_id: c.env.ADMIN_GROUP_ID,
  text, parse_mode: "HTML",
  link_preview_options: { is_disabled: true },
  reply_markup: markup
};
// editMessageText({ ...base, message_id: user.blacklist_msg_id })
// sendMessage({ ...base, message_thread_id: topicId })
```

两调用仅隔约 13 行、漂移风险低，但抽 `base` 后卡片的形状只在一处可见，可读性提升明确。无行为变化。

### 5. `sentTo` 收敛为 `countSentTo` 的投影

```js
const countSentTo = (chatId, needle) =>
  tgCalls.filter(c => c.method.startsWith("send") && String(c.body.chat_id) === String(chatId) && String(c.body.text || c.body.caption || "").includes(needle)).length;
const sentTo = (chatId, needle) => countSentTo(chatId, needle) > 0;
```

三条件谓词原本逐字写两遍（`some` 版与 `filter` 版）。`some(p)` ⟺ `filter(p).length > 0`，语义等价。这是四处里 ROI 最高的去重——谓词非平凡，未来加第四个条件时只会改一处。`countSentTo` 定义在前、`sentTo` 在后投影。

## 观察（不在本次范围）

`topic-relay` 的"Update 幂等处理"要求枚举的副作用是消息类（转发、复制、发送提示、创建话题、表情回应），未覆盖管理员可见的**配置列表变更**（qa_add/ar_add 的 append）。`entryId`/`appendOnce` 恰是为这类变更的重放幂等而建，但规格对此沉默。这是一处真实但独立的缺口；补它属于新增要求、超出"清理"范畴，留作后续变更。

## 风险与缓解

| 项 | 失败模式 | 缓解 |
|---|---|---|
| #2 entryId | 未来新增绕过 `processUpdate` 的 `entryId` 调用路径 → 简化后得 `"uundefined"`（稳定，调用间塌缩成一条），现状得随机 id（每条独立）。形态不同，但都不正确 | 不变量结构性维持（`dispatch` 单一入口）；新调用路径会在 review 暴露。真 tripwire 应 `throw`，但超出"简化"范畴 |
| #3 sendWelcomeOnce | 同上未来路径：删守卫后若 `c.updateId` 为空，`String(undefined)="undefined"` 会让条件 UPDATE 永久占住、welcome 只发一次；现状 key=null 会跳守卫每次都发。不可达路径上从"宽松"变"严格" | 不可达，moot。注意"零行为变化"仅对**可达路径**成立——这是四处里唯一不可达路径形态改变的项 |
| #3 String() | 有人误以为 `String()` 承重而保留、或误以为可删而引入裸数字——两种盲改都"碰巧"无碍（亲和兜底），但理由错了 | 本 design 记录亲和分析，使未来修改有据 |
| #4 base | 未来 `editMessageText` 需要不共享的字段 → 误用 `base` | 当前无此字段；spread 意图清晰 |
| #5 谓词 | `tgCalls` 迭代中被修改 → `some` 与 `filter.length` 行为不同 | 测试中不发生 |
