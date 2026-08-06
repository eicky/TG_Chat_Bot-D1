# Proposal: fix-verification-bypass-and-message-loss

## Why

代码审查在 `worker.js` 中发现 4 个缺陷，全部经 PoC 实测复现，均在 `rebuild-contact-bot` 重写时引入并存续至今（已用 `git show HEAD:worker.js` 逐一确认，非工作区未提交改动引入）。其中两个导致核心能力实际失效：

**1. 人机验证可被 100% 绕过（Critical）** — 实测：开启人机验证后，用户 `/start` 收到验证链接但**不点击**，直接发送第二条消息即被标记 `verified`，第三条消息正常送达管理群。

根因在 `advanceVerification`（`worker.js:731`）把"验证码从未开始"（`new`）与"验证码已下发、用户未完成"（`captcha_pending`）合并为同一分支处理。该分支被 `handleTokenSubmit`（`worker.js:928/948`）**有意复用**：它伪造 `{...user, state: "captcha_pending"}` 来触发"推进到下一步"。这个内部约定的语义是"验证码这一步已被满足"，而非字面的"数据库状态是 captcha_pending"。但 `handlePrivate`（`worker.js:994`）传入的是**从数据库读出、本次未经任何校验的真实状态**，当其恰为 `captcha_pending` 时命中同一分支，前提却不成立。`user-verification` spec 的"人机验证（双模态）"要求（token 须经 siteverify 校验）因此在此路径上完全不生效。

**2. 用户消息静默丢失（Critical）** — 实测：话题被删除后用户发消息，成功投递管理群 0 次、用户无任何提示、无"已送达"标记、HTTP 200（Telegram 不会重投）。消息永久消失且双方均无感知。

根因是 `handleTopicError` 返回 `"retry" | "ok" | "gone"` 三种值，而 `forwardToTopic`（`worker.js:1170-1183`）只处理前两种；`"gone"` 时两个 `if` 均不命中，函数无异常返回，`ok` 保持 `false`。这直接违反 `topic-relay` spec 的"话题失效自动重建"意图——映射虽被清空（下条消息会重建），但**触发重建的那条消息本身被吞掉了**。

现有冒烟测试对此存在精确盲区：`smoke-test.mjs:422-431` 构造了话题被删场景，却只断言 `topic_id === null`，未捕获返回状态码、未断言消息去向；同一测试块中"话题被关闭"场景则明确断言了 `r.status === 500`。两者严谨度不对称，正是该缺陷长期存活的原因。

**3. 验证页反射型 XSS（High）** — `esc()`（`worker.js:572`）转义 `& < > " '` 但**遗漏反斜杠**。注入点 `var UID = "${esc(uid)}", NONCE = "${esc(nonce)}";`（`worker.js:865`）有两个攻击者可控变量，反斜杠可吃掉闭合引号使字符串边界偏移。实测 PoC 真实执行任意代码：

```
/verify?uid=%5C&nonce=%3BPWNED()%3B%2F%2F
→ var UID = "\", NONCE = ";PWNED();//";
```

`</script>` 向量已被现有转义堵死，反斜杠是唯一可用路径。注入代码在 `tg.ready()` 之后运行，可外传受害者的 `tg.initData`（有效期 600 秒），进而重放调用 `/submit_token` 冒充其完成验证。前提为诱导受害者点击链接。

**4. ReDoS 防护可绕过（Medium）** — `RE_REJECT`（`worker.js:83`）四条规则全部围绕括号分组构造，对无括号的连续量词链无检测能力。实测 `re:a*a*a*...b`（20 个 `a*`）在 512 字符输入下耗时 **228 秒**，足以耗尽 Worker CPU。前提是管理员配置了该正则，故定级 Medium。

## What Changes

- **修复验证码绕过**：拆分 `advanceVerification` 中被合并的 `new` / `captcha_pending` 分支，使"验证码已满足"成为**显式参数**而非靠伪造 `state` 字段传达的隐式约定。`handlePrivate` 传入未经校验的真实状态时，`captcha_pending` MUST 重新下发验证入口而非推进；`handleTokenSubmit` 在完成 siteverify 后显式声明该步已满足。
- **修复静默丢消息**：`forwardToTopic` 补齐 `"gone"` 分支处理——话题已重建映射被清空时，MUST 抛 `RetryLater` 交由 Telegram 重投（重投时 `ensureUserTopic` 会新建话题并成功送达），而非静默返回。
- **修复 XSS**：引入专用于 JS 字符串上下文的 `jsLiteral()`（`JSON.stringify` 处理引号与反斜杠，并转义 `<` 防止 `</script>` 提前闭合脚本元素），验证页的 `uid`/`nonce` 改用它注入，不再让 HTML 转义函数承担 JS 字符串转义职责。`esc()` 维持纯 HTML 转义不变——反斜杠须保留原文，否则面板展示正则屏蔽词（如 `re:加微信\d+`）会被渲染成 `&#92;d+`。
- **修复 ReDoS**：`RE_REJECT` 增加量词总数上限规则，覆盖无括号量词链。阈值经实测标定为 6——8 个正常管理员正则的量词数上限为 3，4 个已知恶意样本的下限为 8，边界留有余量。
- **补测试**：为上述 4 项各补冒烟测试，并修正 `smoke-test.mjs` 中"话题被删"场景的断言盲区（补充状态码与消息去向断言）。

## Capabilities

### Modified Capabilities

- `user-verification`: 澄清"人机验证已满足"的判定依据——MUST 基于本次请求实际完成的校验，而非用户在数据库中的驻留状态；未完成验证码的用户重复发消息 MUST 重新获得验证入口。新增验证页参数注入的转义要求。
- `topic-relay`: 明确话题失效重建时**触发重建的那条消息本身**不得丢失，MUST 通过重投送达。
- `keyword-filter`: 正则安全约束补充量词总数上限。

（`openspec/specs/` 尚未建立基线——`rebuild-contact-bot` 未归档，故本变更的增量规格以 `MODIFIED Requirements` 表达，归档时与其合并。）

## Impact

- **代码**：仅 `worker.js`，函数局部改动（`advanceVerification`、`handlePrivate`/`handleTokenSubmit` 调用点、`forwardToTopic`、新增 `jsLiteral`、`handleVerifyPage`、`matchKeyword` 量词上限）。无 schema 变更、无新增依赖、无部署步骤变更。
- **测试**：`smoke-test.mjs` 新增约 10 项断言，修正 1 处既有盲区。
- **行为变化（面向用户可见）**：此前因缺陷 1 已被误标记为 `verified` 的用户**不会**被追溯回收——修复只阻断新的绕过路径。若需清算存量，管理员可用 `/reset <用户ID>` 逐个重置；是否清算由运营决定，不在本变更范围。
- **兼容性**：无破坏性变更，无数据迁移。
