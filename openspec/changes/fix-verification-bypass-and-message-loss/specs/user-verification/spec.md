# user-verification 增量规格

## Purpose

修复人机验证可被完全绕过的缺陷，并明确验证页参数注入的转义要求。

## MODIFIED Requirements

### Requirement: 人机验证（双模态）

人机验证开启时，系统 MUST 向用户发送打开验证页（Telegram Mini App）的按钮；验证页 MUST 按当前配置的验证码模式渲染对应组件（Cloudflare Turnstile 或 Google reCAPTCHA v2）。验证提交 MUST 满足全部条件才通过：Telegram initData 签名验证有效（用户身份以验签结果为准，不信任客户端参数）、一次性 nonce 与签发记录一致且未过期、验证码 token 经当前模式对应的服务端 siteverify 接口校验通过。

「人机验证已满足」MUST 依据本次请求实际完成的校验来判定，MUST NOT 依据用户在数据库中的驻留状态推断。处于「验证码已下发、尚未完成」状态的用户再次发送消息时，系统 MUST 重新下发验证入口，MUST NOT 将其推进到下一验证阶段或标记为已验证。

#### Scenario: 人机验证通过

- **WHEN** 用户在验证页完成验证码并提交，initData 验签、nonce、token 校验全部通过
- **THEN** 用户进入下一验证阶段（问答开启时）或直接标记为已验证，并收到通过提示

#### Scenario: reCAPTCHA 模式生效

- **WHEN** 验证码模式配置为 Google reCAPTCHA，用户打开验证页并提交
- **THEN** 验证页渲染 reCAPTCHA 组件，token 经 Google siteverify 接口校验

#### Scenario: initData 验签失败

- **WHEN** 提交请求的 initData 缺失、过期或签名不匹配
- **THEN** 提交被拒绝，用户验证状态不变

#### Scenario: nonce 过期或不匹配

- **WHEN** 提交携带的 nonce 与签发记录不一致，或签发时间超过有效期
- **THEN** 提交被拒绝，用户须重新发起 /start 获取新验证

#### Scenario: 不完成验证码直接发消息不得推进

- **WHEN** 人机验证开启，用户 /start 收到验证链接后不点击，直接发送另一条普通消息
- **THEN** 用户状态保持为待验证，不被标记为已验证，消息不转发到管理群，用户重新收到验证入口

#### Scenario: 不完成验证码不得跳到问答阶段

- **WHEN** 人机验证与问答均开启，用户 /start 收到验证链接后不点击，直接发送另一条普通消息
- **THEN** 用户不进入问答阶段，不收到题目，仍处于人机验证待完成状态

#### Scenario: 验证码关闭后待验证用户可脱困

- **WHEN** 用户处于「验证码已下发未完成」状态，管理员随后关闭人机验证，用户再发消息
- **THEN** 用户按剩余流程推进（问答开启且题库非空则抽题，否则标记为已验证），不被卡死

### Requirement: 验证页参数转义

验证页 MUST 将来自 URL 查询参数的 `uid`、`nonce` 以 JavaScript 字符串字面量安全的方式注入页面脚本；注入结果 MUST NOT 允许参数内容逃逸出字符串上下文成为可执行代码。

转义职责按上下文分离：JS 字符串上下文 MUST 使用专用于该上下文的转义（处理引号、反斜杠，并转义 `<` 以防 `</script>` 提前闭合脚本元素）。用于 HTML 上下文的转义函数 MUST NOT 转义反斜杠——面板需按原文回显含反斜杠的正则屏蔽词（如 `re:加微信\d+`），转义会使其显示为 `&#92;d+`。

#### Scenario: 反斜杠不得逃逸字符串上下文

- **WHEN** 攻击者构造 `uid` 以反斜杠结尾、`nonce` 含分号与注释符的验证页链接并诱导受害者打开
- **THEN** 参数内容始终留在字符串字面量内部，注入的代码不被执行

#### Scenario: 尖括号不得逃逸标签上下文

- **WHEN** 验证页参数含 `</script>` 或 HTML 标签片段
- **THEN** 内容被转义，不产生新的可执行标签
