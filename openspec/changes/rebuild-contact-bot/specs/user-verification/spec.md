# user-verification 增量规格

## Purpose

首次联系机器人的用户必须先通过验证才能与管理员对话：人机验证（Cloudflare Turnstile / Google reCAPTCHA 可切换）与自定义问答两道关卡，可独立开关、可串联组合，用于拦截脚本与垃圾消息。

## ADDED Requirements

### Requirement: 未验证用户拦截
未完成验证的用户发送的消息 MUST 不被转发到管理群，系统 MUST 引导其进入验证流程（发送欢迎语与当前所需的验证步骤）。

#### Scenario: 未验证用户发消息
- **WHEN** 状态为未验证的用户发送普通消息
- **THEN** 消息不被转发，用户收到欢迎语及验证引导

### Requirement: 人机验证（双模态）
人机验证开启时，系统 MUST 向用户发送打开验证页（Telegram Mini App）的按钮；验证页 MUST 按当前配置的验证码模式渲染对应组件（Cloudflare Turnstile 或 Google reCAPTCHA v2）。验证提交 MUST 满足全部条件才通过：Telegram initData 签名验证有效（用户身份以验签结果为准，不信任客户端参数）、一次性 nonce 与签发记录一致且未过期、验证码 token 经当前模式对应的服务端 siteverify 接口校验通过。

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

### Requirement: 问答验证（题库随机抽取）
问答验证开启时，系统 MUST 从管理员配置的问答题库中随机抽取一题向用户提问，并记录该用户当前被抽中的题目；判定 MUST 只比对当前抽中题目的答案（去除首尾空白后精确一致）。答对则通过；答错时 MUST 重新随机抽取一题发送（题库仅一题时即重发该题）；以 `/` 开头的输入 MUST 不判为错误答案（交由命令处理）。用户作答时若当前题目已被管理员删除，MUST 重新抽题发送且不判错。题库为空时问答环节 MUST 自动跳过（等效关闭）。

#### Scenario: 随机抽题提问
- **WHEN** 题库含多道题，用户进入问答验证阶段
- **THEN** 用户收到题库中随机一题，系统记录该用户当前需回答的题目

#### Scenario: 回答正确
- **WHEN** 用户发送与其当前被抽中题目的答案一致的文本
- **THEN** 用户被标记为已验证并收到通过提示

#### Scenario: 答案不对应当前题目
- **WHEN** 题库含 A、B 两题，用户被抽中 A 题却发送 B 题的答案
- **THEN** 判定为答错，系统重新随机抽题发送

#### Scenario: 回答错误后换题
- **WHEN** 用户发送错误答案
- **THEN** 用户收到"答案错误"提示与重新随机抽取的题目

#### Scenario: 输入命令不判错
- **WHEN** 处于问答阶段的用户发送 /start
- **THEN** 不计为错误答案，系统重新发送当前验证步骤

#### Scenario: 当前题目被删除
- **WHEN** 用户作答期间管理员删除了其被抽中的题目
- **THEN** 该作答不判错，系统重新抽题发送

#### Scenario: 题库为空
- **WHEN** 问答验证开启但题库为空，用户到达问答环节
- **THEN** 问答环节被跳过，用户按剩余流程直接进入已验证状态

### Requirement: 组合验证顺序
人机验证与问答同时开启时，顺序 MUST 为先人机后问答，两者全部通过后用户才是已验证状态。

#### Scenario: 双重验证
- **WHEN** 两种验证均开启，用户完成人机验证
- **THEN** 系统立即从题库随机抽取一题发送，回答正确后才能发消息

### Requirement: 验证关闭与管理员豁免
两种验证均关闭时，用户首次 /start MUST 直接标记为已验证；`ADMIN_IDS` 中的管理员 MUST 始终豁免验证与限流。

#### Scenario: 全部关闭直接通过
- **WHEN** 两种验证均关闭，新用户发送 /start
- **THEN** 用户直接进入已验证状态

#### Scenario: 管理员免验证
- **WHEN** 管理员账号与机器人私聊
- **THEN** 不触发任何验证流程

### Requirement: 验证提交防滥用
验证提交端点 MUST 先完成 initData 验签再执行任何有状态操作，且同一用户的提交频率 MUST 受限；验签失败与超限请求均以失败响应结束，不产生副作用。

#### Scenario: 无签名请求零成本拒绝
- **WHEN** 提交请求不含有效 initData 签名
- **THEN** 请求被直接拒绝，不读写任何用户状态

#### Scenario: 单用户提交超限
- **WHEN** 同一用户一分钟内提交次数超过限额
- **THEN** 后续提交被拒绝

### Requirement: 屏蔽用户不可验证
被屏蔽用户 MUST 无法通过任何验证路径推进状态；/start 也 MUST 不解除屏蔽。

#### Scenario: 屏蔽用户提交验证
- **WHEN** 被屏蔽用户提交人机验证或回答问题
- **THEN** 提交被拒绝，状态不变
