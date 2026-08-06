/**
 * 冒烟测试：用 node:sqlite 提供真实 SQL 执行的 D1 适配层，mock 外部 HTTP（Telegram / siteverify）。
 * 校验对象是 worker.js 的真实逻辑：SQL 真的执行、状态机真的跑。
 */
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.js";

// ---------- D1 适配层 ----------
function makeD1() {
  const db = new DatabaseSync(":memory:");
  const wrap = sql => ({
    bind(...args) {
      const p = args.map(a => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a));
      return {
        async all() {
          return { results: db.prepare(sql).all(...p) };
        },
        async first() {
          const r = db.prepare(sql).all(...p);
          return r.length ? r[0] : null;
        },
        async run() {
          // RETURNING 语句必须用 all() 取，否则 node:sqlite 报错
          if (/RETURNING/i.test(sql)) {
            const rows = db.prepare(sql).all(...p);
            return { meta: { changes: rows.length }, results: rows };
          }
          const r = db.prepare(sql).run(...p);
          return { meta: { changes: Number(r.changes) } };
        }
      };
    },
    async all() {
      return { results: db.prepare(sql).all() };
    },
    async first() {
      const r = db.prepare(sql).all();
      return r.length ? r[0] : null;
    },
    async run() {
      const r = db.prepare(sql).run();
      return { meta: { changes: Number(r.changes) } };
    }
  });

  return {
    prepare: wrap,
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    _raw: db
  };
}

// ---------- 环境与 mock ----------
const SECRET = "test-secret";
let tgCalls = [];
let siteverifyOk = true;
let topicSeq = 100;
let tgFailNext = null; // { method, error } 让下一次指定方法失败

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);

  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    tgCalls.push({ method, body });

    if (tgFailNext && tgFailNext.method === method) {
      const err = tgFailNext.error;
      tgFailNext = null;
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: err }), { status: 400 });
    }

    let result = true;
    if (method === "createForumTopic") result = { message_thread_id: ++topicSeq };
    else if (method.startsWith("send") || method === "copyMessage" || method === "forwardMessage") {
      result = { message_id: Math.floor(Math.random() * 100000), message_thread_id: body.message_thread_id };
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }

  if (u.includes("siteverify")) {
    return new Response(JSON.stringify({ success: siteverifyOk }), { status: 200 });
  }
  return realFetch(url, init);
};

function makeEnv() {
  return {
    TG_BOT_DB: makeD1(),
    BOT_TOKEN: "123:ABC",
    ADMIN_IDS: "900001",
    ADMIN_GROUP_ID: "-1001234567890",
    WORKER_URL: "https://bot.example.workers.dev",
    TELEGRAM_WEBHOOK_SECRET: SECRET,
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "secret",
    RECAPTCHA_SITE_KEY: "rsite",
    RECAPTCHA_SECRET_KEY: "rsecret"
  };
}

const ctx = { waitUntil: p => p.catch(() => {}) };
let uid = 1;
const webhook = (env, update, secret = SECRET) =>
  worker.fetch(
    new Request("https://bot.example.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: uid++, ...update })
    }),
    env,
    ctx
  );

const privateMsg = (from, text, extra = {}) => ({
  message: {
    message_id: Math.floor(Math.random() * 100000),
    date: Math.floor(Date.now() / 1000),
    chat: { id: from, type: "private" },
    from: { id: from, first_name: "小明", username: "xiaoming" },
    text,
    ...extra
  }
});

const groupMsg = (fromId, threadId, text) => ({
  message: {
    message_id: Math.floor(Math.random() * 100000),
    date: Math.floor(Date.now() / 1000),
    chat: { id: -1001234567890, type: "supergroup" },
    message_thread_id: threadId,
    from: { id: fromId, first_name: "管理员" },
    text
  }
});

const callback = (fromId, data, msgId = 555, threadId = null) => ({
  callback_query: {
    id: "cb" + Math.random(),
    from: { id: fromId, first_name: "管理员" },
    message: { message_id: msgId, chat: { id: fromId, type: "private" }, message_thread_id: threadId },
    data
  }
});

const sentTo = (chatId, needle) =>
  tgCalls.some(c => c.method.startsWith("send") && String(c.body.chat_id) === String(chatId) && String(c.body.text || c.body.caption || "").includes(needle));
const called = m => tgCalls.filter(c => c.method === m);
const reset = () => (tgCalls = []);

// ---------- 断言框架 ----------
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  ✗ ${name} ${detail}`); }
}
const section = t => console.log(`\n▶ ${t}`);

const setCfgDirect = (env, k, v) =>
  env.TG_BOT_DB._raw.prepare("INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
const getUserRow = (env, id) => env.TG_BOT_DB._raw.prepare("SELECT * FROM users WHERE user_id=?").all(String(id))[0];

// ============================================================
async function run() {
  // ---- topic-relay: webhook 鉴别 ----
  section("topic-relay：Webhook 请求鉴别");
  {
    const env = makeEnv();
    const bad = await webhook(env, privateMsg(1001, "/start"), "wrong-secret");
    check("伪造 secret 返回 403", bad.status === 403, `got ${bad.status}`);
    const none = await worker.fetch(
      new Request("https://x/", { method: "POST", body: "{}" }), env, ctx);
    check("缺失 secret 返回 403", none.status === 403, `got ${none.status}`);
  }

  // ---- user-verification: 全关直通 + 已验证转发 ----
  section("user-verification：验证全关 → 直接通过");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1002, "/start")); // 建表
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    reset();
    await webhook(env, privateMsg(1003, "/start"));
    check("新用户直接标记 verified", getUserRow(env, 1003)?.state === "verified");
    check("收到欢迎语", sentTo(1003, "欢迎"));
    check("收到验证通过提示", sentTo(1003, "验证通过"));
  }

  // ---- user-verification: 问答题库随机抽题 ----
  section("user-verification：问答题库随机抽取");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1004, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "true");
    setCfgDirect(env, "qa_questions", JSON.stringify([
      { id: "q1", q: "1+1=?", a: "2" },
      { id: "q2", q: "暗号是什么", a: "芝麻开门" }
    ]));

    reset();
    await webhook(env, privateMsg(1005, "/start"));
    const u = getUserRow(env, 1005);
    check("状态为 qa_pending", u?.state === "qa_pending", `state=${u?.state}`);
    check("记录了当前抽中题目 id", u?.qa_question_id === "q1" || u?.qa_question_id === "q2", `qid=${u?.qa_question_id}`);

    // 答另一题的答案 → 必须判错
    const asked = u.qa_question_id;
    const wrongAnswer = asked === "q1" ? "芝麻开门" : "2";
    reset();
    await webhook(env, privateMsg(1005, wrongAnswer));
    check("答非当前题的答案判错", getUserRow(env, 1005)?.state === "qa_pending");
    check("答错后重新发题", sentTo(1005, "答案错误"));

    // 答对当前题
    const nowQid = getUserRow(env, 1005).qa_question_id;
    const right = nowQid === "q1" ? "2" : "芝麻开门";
    reset();
    await webhook(env, privateMsg(1005, right));
    check("答对后 verified", getUserRow(env, 1005)?.state === "verified");
    check("收到通过提示", sentTo(1005, "验证通过"));

    // 命令不判错
    setCfgDirect(env, "qa_questions", JSON.stringify([{ id: "q1", q: "1+1=?", a: "2" }]));
    await webhook(env, privateMsg(1006, "/start"));
    reset();
    await webhook(env, privateMsg(1006, "/start"));
    check("问答阶段 /start 不判错", !sentTo(1006, "答案错误"));

    // 题库为空 → 跳过
    setCfgDirect(env, "qa_questions", "[]");
    reset();
    await webhook(env, privateMsg(1007, "/start"));
    check("题库为空时跳过问答", getUserRow(env, 1007)?.state === "verified", `state=${getUserRow(env, 1007)?.state}`);
  }

  // ---- topic-relay: 话题创建与转发 ----
  section("topic-relay：话题创建、转发、送达标记");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1010, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1011, "/start"));

    reset();
    await webhook(env, privateMsg(1011, "你好，请问在吗"));
    const created = called("createForumTopic");
    check("创建了话题", created.length === 1, `count=${created.length}`);
    check("话题名含名称与ID", String(created[0]?.body.name).includes("1011"), created[0]?.body.name);
    check("消息被转发", called("forwardMessage").length === 1);
    check("打了送达 reaction", called("setMessageReaction").length === 1);
    check("发送了资料卡", tgCalls.some(c => c.method === "sendMessage" && String(c.body.text || "").includes("用户资料")));
    check("资料卡被置顶", called("pinChatMessage").length === 1);

    // 第二条消息复用同一话题
    reset();
    await webhook(env, privateMsg(1011, "第二条"));
    check("复用话题不重复创建", called("createForumTopic").length === 0);
  }

  // ---- topic-relay: update 去重 ----
  section("topic-relay：update 幂等去重");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1020, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1021, "/start"));
    await webhook(env, privateMsg(1021, "消息"));

    const dup = { update_id: 999999, ...privateMsg(1021, "重投消息") };
    const mk = () => worker.fetch(new Request("https://x/", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
      body: JSON.stringify(dup)
    }), env, ctx);

    reset();
    const r1 = await mk();
    const first = called("forwardMessage").length;
    reset();
    const r2 = await mk();
    check("首次处理返回 200", r1.status === 200);
    check("首次转发了消息", first === 1, `count=${first}`);
    check("重投返回 200", r2.status === 200);
    check("重投不重复转发", called("forwardMessage").length === 0);
  }

  // ---- topic-relay: 并发首消息只建一个话题 ----
  section("topic-relay：并发首消息 → 单话题 + 500 重投");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1030, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1031, "/start"));

    reset();
    const results = await Promise.all([
      webhook(env, privateMsg(1031, "并发1")),
      webhook(env, privateMsg(1031, "并发2")),
      webhook(env, privateMsg(1031, "并发3"))
    ]);
    const statuses = results.map(r => r.status);
    check("只创建一个话题", called("createForumTopic").length === 1, `count=${called("createForumTopic").length}`);
    check("至少一条成功(200)", statuses.includes(200), JSON.stringify(statuses));
    check("未抢到的返回 500 交重投", statuses.filter(s => s === 500).length >= 1, JSON.stringify(statuses));

    // 重投后应成功转发
    reset();
    const retry = await webhook(env, privateMsg(1031, "重投的消息"));
    check("重投时话题已就绪并转发", retry.status === 200 && called("forwardMessage").length === 1);
  }

  // ---- keyword-filter ----
  section("keyword-filter：屏蔽词、阈值封禁、正则防护");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1040, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "block_keywords", JSON.stringify(["SPAM", "re:加微信\\d+", "re:(a+)+$"]));
    setCfgDirect(env, "block_threshold", "3");
    await webhook(env, privateMsg(1041, "/start"));

    reset();
    await webhook(env, privateMsg(1041, "这是 spam 消息"));
    check("子串匹配不区分大小写", getUserRow(env, 1041)?.strike_count === 1);
    check("命中后不转发", called("forwardMessage").length === 0);
    check("发出违规警告", sentTo(1041, "违禁词"));

    reset();
    await webhook(env, privateMsg(1041, "加微信12345"));
    check("re: 正则条目匹配", getUserRow(env, 1041)?.strike_count === 2);

    reset();
    const t0 = Date.now();
    await webhook(env, privateMsg(1041, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"));
    const elapsed = Date.now() - t0;
    check("危险正则被拒绝不超时", elapsed < 2000, `${elapsed}ms`);
    check("危险正则视为不匹配(不计违规)", getUserRow(env, 1041)?.strike_count === 2, `strikes=${getUserRow(env, 1041)?.strike_count}`);

    reset();
    await webhook(env, privateMsg(1041, "又是 SPAM"));
    check("第三次命中触发封禁", getUserRow(env, 1041)?.is_blocked === 1, `blocked=${getUserRow(env, 1041)?.is_blocked}`);
    check("发出封禁通知", sentTo(1041, "自动封禁"));
    check("生成黑名单话题", called("createForumTopic").length >= 1);

    // 被屏蔽后不再转发
    reset();
    await webhook(env, privateMsg(1041, "普通消息"));
    check("屏蔽后消息不转发", called("forwardMessage").length === 0);
    check("屏蔽提示已发送", sentTo(1041, "已被管理员屏蔽"));

    // /start 不解封
    reset();
    await webhook(env, privateMsg(1041, "/start"));
    check("/start 不解除屏蔽", getUserRow(env, 1041)?.is_blocked === 1);
  }

  // ---- keyword-filter: 自动回复 ----
  section("keyword-filter：自动回复");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1050, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "auto_replies", JSON.stringify([{ id: "a1", kw: "价格", reply: "请联系人工客服" }]));
    await webhook(env, privateMsg(1051, "/start"));

    reset();
    await webhook(env, privateMsg(1051, "价格多少"));
    check("命中自动回复", sentTo(1051, "请联系人工客服"));
    check("消息仍正常转发", called("forwardMessage").length === 1);
  }

  // ---- topic-relay: 消息类型过滤 ----
  section("topic-relay：消息类型过滤");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1060, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "allow_sticker", "false");
    await webhook(env, privateMsg(1061, "/start"));

    reset();
    await webhook(env, { message: { ...privateMsg(1061, "").message, text: undefined, sticker: { file_id: "s1" } } });
    check("关闭的贴纸被拦截", called("forwardMessage").length === 0);
    check("提示不接收该类型", sentTo(1061, "不接收"));

    reset();
    await webhook(env, privateMsg(1061, "文本消息"));
    check("开启的文本正常转发", called("forwardMessage").length === 1);

    // 频道转发单独判定
    setCfgDirect(env, "allow_channel", "false");
    setCfgDirect(env, "allow_forward", "true");
    reset();
    await webhook(env, { message: { ...privateMsg(1061, "转发内容").message, forward_from_chat: { type: "channel", id: -100999 } } });
    check("频道转发单独拦截", called("forwardMessage").length === 0);
  }

  // ---- topic-relay: 话题失效恢复 ----
  section("topic-relay：话题删除/关闭恢复");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1070, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1071, "/start"));
    await webhook(env, privateMsg(1071, "建话题"));
    const topicBefore = getUserRow(env, 1071)?.topic_id;

    // 话题被删除
    reset();
    tgFailNext = { method: "forwardMessage", error: "Bad Request: message thread not found" };
    await webhook(env, privateMsg(1071, "话题被删后的消息"));
    check("删除后清空话题映射", getUserRow(env, 1071)?.topic_id === null, `topic=${getUserRow(env, 1071)?.topic_id}`);

    reset();
    await webhook(env, privateMsg(1071, "下一条消息"));
    check("下条消息自动重建话题", called("createForumTopic").length === 1);
    check("重建后话题 ID 变化", getUserRow(env, 1071)?.topic_id !== topicBefore);

    // 话题被关闭 → 自动 reopen
    reset();
    tgFailNext = { method: "forwardMessage", error: "Bad Request: TOPIC_CLOSED" };
    const r = await webhook(env, privateMsg(1071, "话题被关后的消息"));
    check("关闭时调用 reopenForumTopic", called("reopenForumTopic").length === 1);
    check("重开后请求重投(500)", r.status === 500, `status=${r.status}`);
    check("关闭不清空话题映射", getUserRow(env, 1071)?.topic_id !== null);

    // 临时错误不清映射
    const topicKeep = getUserRow(env, 1071)?.topic_id;
    reset();
    tgFailNext = { method: "forwardMessage", error: "Too Many Requests: retry after 1" };
    await webhook(env, privateMsg(1071, "限流消息"));
    check("临时错误不清空映射", getUserRow(env, 1071)?.topic_id === topicKeep);
  }

  // ---- topic-relay: 限流 ----
  section("topic-relay：用户消息限流");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1080, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1081, "/start"));
    await webhook(env, privateMsg(1081, "首条建话题"));

    reset();
    for (let i = 0; i < 10; i++) await webhook(env, privateMsg(1081, `快速消息${i}`));
    const forwarded = called("forwardMessage").length;
    check("超限消息被拦截", forwarded < 10, `forwarded=${forwarded}`);
    const notices = tgCalls.filter(c => String(c.body.text || "").includes("过于频繁")).length;
    check("限流提示防抖(仅1次)", notices === 1, `notices=${notices}`);
  }

  // ---- moderation: 手动屏蔽/解封 ----
  section("moderation：手动屏蔽/解封与权限");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1090, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1091, "/start"));
    await webhook(env, privateMsg(1091, "建话题"));

    // 非管理员点击 → 拒绝
    reset();
    await webhook(env, callback(777777, "block:1091"));
    check("非管理员操作被拒", getUserRow(env, 1091)?.is_blocked === 0);
    check("返回无权限提示", tgCalls.some(c => c.method === "answerCallbackQuery" && String(c.body.text).includes("无权限")));

    // 管理员屏蔽
    reset();
    await webhook(env, callback(900001, "block:1091"));
    check("管理员屏蔽成功", getUserRow(env, 1091)?.is_blocked === 1);
    check("生成黑名单卡片", tgCalls.some(c => c.method === "sendMessage" && String(c.body.text || "").includes("用户已屏蔽")));
    check("刷新资料卡", called("editMessageText").length >= 1);
    check("通知用户被屏蔽", sentTo(1091, "已被管理员屏蔽"));

    // 解封
    reset();
    await webhook(env, callback(900001, "unblock:1091"));
    check("解封成功", getUserRow(env, 1091)?.is_blocked === 0);
    check("删除黑名单卡片", called("deleteMessage").length === 1);
    check("通知用户解封", sentTo(1091, "解除屏蔽"));
  }

  // ---- moderation: /reset 与 /note ----
  section("moderation：/reset 与 /note");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1100, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1101, "/start"));
    await webhook(env, privateMsg(1101, "建话题"));
    const threadId = getUserRow(env, 1101)?.topic_id;

    reset();
    await webhook(env, groupMsg(900001, threadId, "/note 重要客户"));
    check("备注已保存", getUserRow(env, 1101)?.note === "重要客户");
    check("刷新了资料卡", called("editMessageText").length >= 1);

    reset();
    await webhook(env, groupMsg(900001, threadId, "/note"));
    check("空 /note 清除备注", getUserRow(env, 1101)?.note === null);

    // 话题内普通消息 → 转达用户
    reset();
    await webhook(env, groupMsg(900001, threadId, "您好，有什么可以帮您"));
    const copies = called("copyMessage").filter(c => String(c.body.chat_id) === "1101");
    check("管理员回复转达给用户", copies.length === 1);

    // /reset
    reset();
    await webhook(env, privateMsg(900001, "/reset 1101"));
    check("重置为未验证", getUserRow(env, 1101)?.state === "new");
    check("通知目标用户", sentTo(1101, "重新验证"));
    check("回执管理员", sentTo(900001, "已重置"));

    reset();
    await webhook(env, privateMsg(900001, "/reset abc"));
    check("非法参数返回用法", sentTo(900001, "用法"));
  }

  // ---- admin-panel ----
  section("admin-panel：面板入口、切换、题库、输入态");
  {
    const env = makeEnv();
    reset();
    await webhook(env, privateMsg(900001, "/start"));
    check("管理员 /start 打开面板", sentTo(900001, "控制面板"));
    check("管理员不触发验证", !sentTo(900001, "安全验证"));

    // 验证码三态轮换
    reset();
    await webhook(env, callback(900001, "panel:captcha_rotate"));
    let mode = env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='captcha_mode'").all()[0]?.value;
    check("轮换到 Google", mode === "recaptcha", `mode=${mode}`);
    await webhook(env, callback(900001, "panel:captcha_rotate"));
    const enabled = env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='enable_captcha'").all()[0]?.value;
    check("再轮换到关闭", enabled === "false", `enabled=${enabled}`);

    // 开关切换
    await webhook(env, callback(900001, "panel:toggle:enable_qa:verify"));
    const qa = env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='enable_qa'").all()[0]?.value;
    check("问答开关切换生效", qa === "false", `qa=${qa}`);

    // 题库添加（输入态）
    reset();
    await webhook(env, callback(900001, "panel:input:qa_add"));
    check("进入输入态提示格式", tgCalls.some(c => String(c.body.text || "").includes("问题===答案")));
    reset();
    await webhook(env, privateMsg(900001, "首都是哪===北京"));
    const bank = JSON.parse(env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='qa_questions'").all()[0]?.value || "[]");
    check("题目已入库", bank.length === 1 && bank[0].q === "首都是哪" && bank[0].a === "北京", JSON.stringify(bank));
    check("保存后返回面板", sentTo(900001, "已保存"));

    // 删除题目
    await webhook(env, callback(900001, `panel:del:qa:${bank[0].id}`));
    const bank2 = JSON.parse(env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='qa_questions'").all()[0]?.value || "[]");
    check("题目已删除", bank2.length === 0);

    // /cancel
    await webhook(env, callback(900001, "panel:input:kw_add"));
    reset();
    await webhook(env, privateMsg(900001, "/cancel"));
    check("/cancel 取消输入", sentTo(900001, "已取消"));
    const kws = env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='block_keywords'").all()[0]?.value;
    check("取消后未写入配置", !kws || kws === "[]", `kws=${kws}`);

    // 屏蔽词添加与格式校验
    await webhook(env, callback(900001, "panel:input:ar_add"));
    reset();
    await webhook(env, privateMsg(900001, "格式错误没有分隔符"));
    check("自动回复格式错误被拒", sentTo(900001, "格式错误"));

    // 转发开关
    reset();
    await webhook(env, callback(900001, "panel:toggle:allow_sticker:filter"));
    const st = env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='allow_sticker'").all()[0]?.value;
    check("转发类型开关切换", st === "false", `sticker=${st}`);

    // 非管理员访问面板
    reset();
    await webhook(env, callback(777777, "panel:home"));
    check("非管理员面板回调被拒", tgCalls.some(c => c.method === "answerCallbackQuery" && String(c.body.text).includes("无权限")));

    // 维护：重置黑名单话题
    setCfgDirect(env, "blacklist_topic_id", "12345");
    await webhook(env, callback(900001, "panel:reset_blacklist"));
    const bt = env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key='blacklist_topic_id'").all()[0]?.value;
    check("黑名单话题已重置", bt === "", `bt=${bt}`);
  }

  // ---- admin-panel: HTML 特殊字符 ----
  section("admin-panel：配置值含 HTML 字符不致面板失灵");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(900001, "/start"));
    setCfgDirect(env, "welcome_msg", "欢迎 <script>alert(1)</script> {name}");
    reset();
    const r = await webhook(env, callback(900001, "panel:welcome"));
    check("面板正常渲染", r.status === 200);
    const rendered = tgCalls.find(c => String(c.body.text || "").includes("欢迎语"));
    check("HTML 字符被转义", rendered && String(rendered.body.text).includes("&lt;script&gt;"), rendered ? "未转义" : "未渲染");
  }

  // ---- user-verification: submit_token ----
  section("user-verification：/submit_token 验签与 nonce");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1110, "/start"));
    setCfgDirect(env, "enable_captcha", "true");
    setCfgDirect(env, "enable_qa", "false");

    reset();
    await webhook(env, privateMsg(1111, "/start"));
    const u = getUserRow(env, 1111);
    check("状态为 captcha_pending", u?.state === "captcha_pending", `state=${u?.state}`);
    check("发送了验证按钮", tgCalls.some(c => JSON.stringify(c.body.reply_markup || {}).includes("web_app")));
    check("生成了 nonce", !!u?.verify_nonce);

    const submit = body =>
      worker.fetch(new Request("https://bot.example.workers.dev/submit_token", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }), env, ctx);

    const r1 = await submit({ token: "t", uid: "1111", nonce: u.verify_nonce, initData: "" });
    check("无 initData 被拒 403", r1.status === 403, `status=${r1.status}`);
    const r2 = await submit({ token: "t", uid: "1111", nonce: u.verify_nonce, initData: "user=%7B%22id%22%3A1111%7D&auth_date=1&hash=deadbeef" });
    check("伪造签名被拒 403", r2.status === 403, `status=${r2.status}`);
    check("拒绝后状态未变", getUserRow(env, 1111)?.state === "captcha_pending");

    // 构造合法 initData
    const { createHmac } = await import("node:crypto");
    const authDate = Math.floor(Date.now() / 1000);
    const userJson = JSON.stringify({ id: 1111, first_name: "小明", username: "xiaoming" });
    const dcs = `auth_date=${authDate}\nuser=${userJson}`;
    const secretKey = createHmac("sha256", "WebAppData").update("123:ABC").digest();
    const hash = createHmac("sha256", secretKey).update(dcs).digest("hex");
    const initData = `auth_date=${authDate}&user=${encodeURIComponent(userJson)}&hash=${hash}`;

    const rBad = await submit({ token: "t", uid: "1111", nonce: "wrong-nonce", initData });
    check("nonce 不匹配被拒", rBad.status === 403, `status=${rBad.status}`);

    reset();
    const rOk = await submit({ token: "t", uid: "1111", nonce: u.verify_nonce, initData });
    check("合法提交通过", rOk.status === 200, `status=${rOk.status}`);
    check("状态变为 verified", getUserRow(env, 1111)?.state === "verified", `state=${getUserRow(env, 1111)?.state}`);
    check("nonce 已作废", !getUserRow(env, 1111)?.verify_nonce);

    // nonce 重放
    const rReplay = await submit({ token: "t", uid: "1111", nonce: u.verify_nonce, initData });
    const replayBody = await rReplay.json();
    check("已验证用户重复提交幂等", rReplay.status === 200 && replayBody.ok === true);

    // 被屏蔽用户不可验证
    env.TG_BOT_DB._raw.prepare("UPDATE users SET is_blocked=1, state='captcha_pending' WHERE user_id='1111'").run();
    const rBlocked = await submit({ token: "t", uid: "1111", nonce: "x", initData });
    check("被屏蔽用户提交被拒", rBlocked.status === 403, `status=${rBlocked.status}`);

    // siteverify 失败
    siteverifyOk = false;
    await webhook(env, privateMsg(1112, "/start"));
    const u2 = getUserRow(env, 1112);
    const userJson2 = JSON.stringify({ id: 1112, first_name: "小红" });
    const dcs2 = `auth_date=${authDate}\nuser=${userJson2}`;
    const hash2 = createHmac("sha256", secretKey).update(dcs2).digest("hex");
    const initData2 = `auth_date=${authDate}&user=${encodeURIComponent(userJson2)}&hash=${hash2}`;
    const rFail = await submit({ token: "bad", uid: "1112", nonce: u2.verify_nonce, initData: initData2 });
    check("验证码校验失败被拒", rFail.status === 403, `status=${rFail.status}`);
    siteverifyOk = true;
  }

  // ---- 验证页 ----
  section("user-verification：验证页渲染");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1120, "/start"));
    const page = await worker.fetch(new Request("https://bot.example.workers.dev/verify?uid=1120&nonce=abc"), env, ctx);
    const html = await page.text();
    check("验证页返回 200", page.status === 200);
    check("默认渲染 Turnstile", html.includes("cf-turnstile") && html.includes("challenges.cloudflare.com"));

    setCfgDirect(env, "captcha_mode", "recaptcha");
    const page2 = await worker.fetch(new Request("https://bot.example.workers.dev/verify?uid=1120&nonce=abc"), env, ctx);
    const html2 = await page2.text();
    check("切换后渲染 reCAPTCHA", html2.includes("g-recaptcha") && html2.includes("google.com/recaptcha"));

    setCfgDirect(env, "enable_captcha", "false");
    const page3 = await worker.fetch(new Request("https://bot.example.workers.dev/verify?uid=1120&nonce=abc"), env, ctx);
    check("关闭验证码后拒绝访问", page3.status === 400);
  }

  // ---- 营业状态 ----
  section("topic-relay：营业状态自动回复");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1130, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "busy_mode", "true");
    await webhook(env, privateMsg(1131, "/start"));

    reset();
    await webhook(env, privateMsg(1131, "第一条"));
    await webhook(env, privateMsg(1131, "第二条"));
    const busyNotices = tgCalls.filter(c => String(c.body.text || "").includes("非营业时间")).length;
    check("忙碌提示只发一次", busyNotices === 1, `count=${busyNotices}`);
    check("消息仍正常转发", called("forwardMessage").length === 2);
  }

  // ---- 编辑消息 ----
  section("topic-relay：编辑消息通知");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1140, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1141, "/start"));
    await webhook(env, privateMsg(1141, "原始消息"));

    reset();
    await webhook(env, { edited_message: privateMsg(1141, "修改后的内容").message });
    check("话题内提示编辑", tgCalls.some(c => String(c.body.text || "").includes("修改了消息")));
  }

  // ---- Cron 清理 ----
  section("scheduled：Cron 清理任务");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1150, "/start"));
    const old = Date.now() - 30 * 24 * 3600 * 1000;
    env.TG_BOT_DB._raw.prepare("INSERT INTO processed_updates (update_id, ts) VALUES ('old-1', ?)").run(old);
    env.TG_BOT_DB._raw.prepare("INSERT INTO ratelimits (key, ts, count) VALUES ('old-key', ?, 1)").run(old);

    const tasks = [];
    await worker.scheduled({}, env, { waitUntil: p => tasks.push(p) });
    await Promise.all(tasks);

    const pu = env.TG_BOT_DB._raw.prepare("SELECT COUNT(*) AS n FROM processed_updates WHERE update_id='old-1'").all()[0].n;
    const rl = env.TG_BOT_DB._raw.prepare("SELECT COUNT(*) AS n FROM ratelimits WHERE key='old-key'").all()[0].n;
    check("清理过期 processed_updates", pu === 0, `n=${pu}`);
    check("清理过期 ratelimits", rl === 0, `n=${rl}`);
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) {
    console.log("\n失败项：");
    failures.forEach(f => console.log("  ✗ " + f));
  }
  console.log("=".repeat(56));
  process.exit(fail ? 1 : 0);
}

run().catch(e => {
  console.error("测试崩溃：", e);
  process.exit(1);
});
