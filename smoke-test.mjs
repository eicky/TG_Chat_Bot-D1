/**
 * 冒烟测试：用 node:sqlite 提供真实 SQL 执行的 D1 适配层，mock 外部 HTTP（Telegram / siteverify）。
 * 校验对象是 worker.js 的真实逻辑：SQL 真的执行、状态机真的跑。
 */
import { DatabaseSync } from "node:sqlite";
import worker from "./worker.js";

// ---------- D1 适配层 ----------
// 允许传入已存在的 DatabaseSync：迁移测试需要两个独立的 D1 绑定对象指向同一个库，
// 才能绕过 worker 内按绑定缓存的 schemaReady，真实地触发第二次迁移。
//
// d1Hook 让指定 SQL 的前 N 次执行抛错。重投类断言需要"副作用已生效、随后某步失败"
// 这一确定性时序：D1 故障是 processUpdate 返回 500 的真实来源之一，
// 而它与 Telegram 失败触发的是同一条重投路径。
const d1Hook = { failOn: null, remaining: 0 };
const armD1 = (re, n = 1) => {
  d1Hook.failOn = re;
  d1Hook.remaining = n;
};
const disarmD1 = () => {
  d1Hook.failOn = null;
  d1Hook.remaining = 0;
};

function makeD1(existing) {
  const db = existing || new DatabaseSync(":memory:");
  const maybeFail = sql => {
    if (d1Hook.failOn && d1Hook.remaining > 0 && d1Hook.failOn.test(sql)) {
      d1Hook.remaining--;
      throw new Error("D1 failure (injected)");
    }
  };
  const wrap = sql => ({
    bind(...args) {
      const p = args.map(a => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a));
      return {
        async all() {
          maybeFail(sql);
          return { results: db.prepare(sql).all(...p) };
        },
        async first() {
          maybeFail(sql);
          const r = db.prepare(sql).all(...p);
          return r.length ? r[0] : null;
        },
        async run() {
          maybeFail(sql);
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
      maybeFail(sql);
      return { results: db.prepare(sql).all() };
    },
    async first() {
      maybeFail(sql);
      const r = db.prepare(sql).all();
      return r.length ? r[0] : null;
    },
    async run() {
      maybeFail(sql);
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
let tgFailAll = null; // { methods, error } 让指定方法持续失败，直到手动清除

// 可编程钩子：按方法记录调用序号，命中规则时按规则返回错误、抛网络异常或挂起。
// 既有 tgFailNext/tgFailAll 覆盖不了「第 N 次调用失败」与「迟到响应」，
// 而话题 fencing、租约接管这类竞态必须由测试确定性地控制时序，不能靠真实时间竞争。
let tgHooks = []; // { method, nth?, error_code?, description?, network?, gate? }
let tgCallSeq = {}; // method -> 已发生的调用次数

/** 创建一个可由测试显式放行的闸门，用于把某次调用挂起到指定时刻 */
function makeGate() {
  let release;
  const promise = new Promise(r => (release = r));
  return { promise, open: () => release() };
}

const resetTgHooks = () => {
  tgHooks = [];
  tgCallSeq = {};
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);

  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    const seq = (tgCallSeq[method] = (tgCallSeq[method] || 0) + 1);
    const record = { method, body, seq };
    tgCalls.push(record);

    // 钩子优先于旧的 failNext/failAll：nth 省略表示对该方法的所有调用生效
    const hook = tgHooks.find(h => h.method === method && (h.nth === undefined || h.nth === seq));
    if (hook) {
      if (hook.gate) await hook.gate.promise; // 挂起到测试放行，用于构造迟到响应
      if (hook.network) throw new Error(hook.description || "network failure");
      if (hook.error_code) {
        return new Response(
          JSON.stringify({ ok: false, error_code: hook.error_code, description: hook.description || "hook error" }),
          { status: hook.error_code }
        );
      }
    }

    if (tgFailAll && tgFailAll.methods.includes(method)) {
      return new Response(
        JSON.stringify({ ok: false, error_code: 502, description: tgFailAll.error }), { status: 502 });
    }

    if (tgFailNext && tgFailNext.method === method) {
      const err = tgFailNext.error;
      tgFailNext = null;
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: err }), { status: 400 });
    }

    record.ok = true; // 标记本次调用成功返回，供"是否真的送达"断言区分
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

let uid = 1;
const webhook = (env, update, secret = SECRET) =>
  worker.fetch(
    new Request("https://bot.example.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify({ update_id: uid++, ...update })
    }),
    env
  );

// 原样投递调用方构造的 update：update_id 不再自增，才能表达 Telegram 用同一 update_id 重投。
// webhook() 每次自增 uid，任何"重投"测试用它写出来都是在投递一条新消息，属于假测试。
const sendRawUpdate = (env, update, secret = SECRET) =>
  worker.fetch(
    new Request("https://bot.example.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update)
    }),
    env
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

// 次数版：重投场景要区分"发过"与"发了几次"；谓词在此唯一定义，sentTo 是其布尔投影
const countSentTo = (chatId, needle) =>
  tgCalls.filter(c => c.method.startsWith("send") && String(c.body.chat_id) === String(chatId) && String(c.body.text || c.body.caption || "").includes(needle)).length;
const sentTo = (chatId, needle) => countSentTo(chatId, needle) > 0;
const called = m => tgCalls.filter(c => c.method === m);
// 只统计成功返回的调用：mock 在判定失败前就已记录，用 called() 会把失败的尝试也算作送达
const delivered = m => tgCalls.filter(c => c.method === m && c.ok);
// 同时清空钩子与调用序号：钩子按场景设置，且 nth 语义相对于本场景的第 N 次调用才直观
const reset = () => {
  tgCalls = [];
  resetTgHooks();
  disarmD1(); // 未消耗完的注入不得泄漏到后续用例
};

// 构造合法 initData（真实 HMAC 签名），供 /submit_token 相关测试复用
const { createHmac: hmac } = await import("node:crypto");
const makeInitData = (userId, name = "小明") => {
  const authDate = Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({ id: userId, first_name: name, username: "u" + userId });
  const dcs = `auth_date=${authDate}\nuser=${userJson}`;
  const secretKey = hmac("sha256", "WebAppData").update("123:ABC").digest();
  const hash = hmac("sha256", secretKey).update(dcs).digest("hex");
  return `auth_date=${authDate}&user=${encodeURIComponent(userJson)}&hash=${hash}`;
};

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
      new Request("https://x/", { method: "POST", body: "{}" }), env);
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
    }), env);

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
    // 计数由原子 UPDATE 的 RETURNING 值驱动警告文本，验证返回的是新值
    check("警告显示当前计数 (2/3)", sentTo(1041, "2/3"));

    reset();
    const t0 = Date.now();
    await webhook(env, privateMsg(1041, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"));
    const elapsed = Date.now() - t0;
    check("危险正则被拒绝不超时", elapsed < 2000, `${elapsed}ms`);
    check("危险正则视为不匹配(不计违规)", getUserRow(env, 1041)?.strike_count === 2, `strikes=${getUserRow(env, 1041)?.strike_count}`);

    reset();
    await webhook(env, privateMsg(1041, "又是 SPAM"));
    check("第三次命中触发封禁", getUserRow(env, 1041)?.is_blocked === 1, `blocked=${getUserRow(env, 1041)?.is_blocked}`);
    // 边界：strike_count + 1 >= threshold 用旧值+1，封禁时计数恰为阈值，不多不少
    check("封禁时计数恰为阈值", getUserRow(env, 1041)?.strike_count === 3, `strikes=${getUserRow(env, 1041)?.strike_count}`);
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

  // ---- keyword-filter: 无括号量词链 ReDoS ----
  section("keyword-filter：无括号量词链不得拖垮匹配");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1044, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    // 无分组的连续量词链：旧规则只查括号构造，这类模式可直接绕过
    setCfgDirect(env, "block_keywords", JSON.stringify(["re:" + "a*".repeat(20) + "b"]));
    await webhook(env, privateMsg(1045, "/start"));

    reset();
    const t0 = Date.now();
    await webhook(env, privateMsg(1045, "a".repeat(40) + "!"));
    const ms = Date.now() - t0;
    check("无括号量词链不产生灾难性回溯", ms < 2000, `${ms}ms`);
    check("危险模式视为不匹配", getUserRow(env, 1045)?.strike_count === 0,
      `strikes=${getUserRow(env, 1045)?.strike_count}`);

    // 正常正则不得被误伤
    const env2 = makeEnv();
    await webhook(env2, privateMsg(1046, "/start"));
    setCfgDirect(env2, "enable_captcha", "false");
    setCfgDirect(env2, "enable_qa", "false");
    setCfgDirect(env2, "block_keywords", JSON.stringify([
      "re:[Vv][Xx]\\s*[:：]?\\s*\\w+",
      "re:客服\\s*QQ\\s*\\d{5,}"
    ]));
    await webhook(env2, privateMsg(1047, "/start"));

    reset();
    await webhook(env2, privateMsg(1047, "vx: abc123"));
    check("多量词正常正则仍生效(vx)", getUserRow(env2, 1047)?.strike_count === 1,
      `strikes=${getUserRow(env2, 1047)?.strike_count}`);
    reset();
    await webhook(env2, privateMsg(1047, "客服QQ 123456"));
    check("多量词正常正则仍生效(QQ)", getUserRow(env2, 1047)?.strike_count === 2,
      `strikes=${getUserRow(env2, 1047)?.strike_count}`);
  }

  // ---- keyword-filter: 自动回复 ----
  section("keyword-filter：自动回复");  {
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

    // 转发失败 → 500 → Telegram 重投同一 update_id：自动回复不得重复发送。
    // claim 只防并发重复处理，不防重投重放，故自动回复必须排在会抛 RetryLater 的转发之后。
    await webhook(env, privateMsg(1052, "/start"));
    await webhook(env, privateMsg(1052, "先建好话题"));
    const updAr = { update_id: 777001, ...privateMsg(1052, "价格多少") };

    reset();
    tgFailAll = { methods: ["forwardMessage", "copyMessage"], error: "Bad Gateway" };
    const rAr1 = await sendRawUpdate(env, updAr);
    tgFailAll = null;
    check("转发失败时请求重投(500)", rAr1.status === 500, `status=${rAr1.status}`);
    const arFirst = countSentTo(1052, "请联系人工客服");

    reset();
    const rAr2 = await sendRawUpdate(env, updAr);
    check("重投后转发成功(200)", rAr2.status === 200, `status=${rAr2.status}`);
    check("重投后消息送达话题", delivered("forwardMessage").length === 1);
    const arRetry = countSentTo(1052, "请联系人工客服");
    check("自动回复总共只发一次", arFirst + arRetry === 1, `首投=${arFirst} 重投=${arRetry}`);
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
    const rGone = await webhook(env, privateMsg(1071, "话题被删后的消息"));
    check("删除后清空话题映射", getUserRow(env, 1071)?.topic_id === null, `topic=${getUserRow(env, 1071)?.topic_id}`);
    // 这条消息本身不能被吞掉：既未送达管理群，就必须请求重投，否则永久丢失且双方无感知
    check("触发重建的消息未送达管理群",
      delivered("forwardMessage").length === 0 && delivered("copyMessage").length === 0);
    check("话题被删时请求重投(500)", rGone.status === 500, `status=${rGone.status}`);

    // 重投：话题重建 + 该消息最终送达
    reset();
    const rRetry = await webhook(env, privateMsg(1071, "话题被删后的消息"));
    check("重投时重建话题", called("createForumTopic").length === 1);
    check("重投后消息送达管理群", delivered("forwardMessage").length === 1);
    check("重投后用户获得已送达标记", called("setMessageReaction").length === 1);
    check("重投返回 200", rRetry.status === 200, `status=${rRetry.status}`);
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
    const rTemp = await webhook(env, privateMsg(1071, "限流消息"));
    check("临时错误不清空映射", getUserRow(env, 1071)?.topic_id === topicKeep);
    check("forward 失败降级 copy 成功后返回 200", rTemp.status === 200, `status=${rTemp.status}`);
    check("降级 copyMessage 送达", delivered("copyMessage").length === 1);

    // forward 与 copy 都失败：不得静默吞掉，必须交重投
    // 用独立用户，避免与上面几条消息共用限流窗口（6 条/2 秒）导致提前返回
    await webhook(env, privateMsg(1072, "/start"));
    await webhook(env, privateMsg(1072, "建话题"));
    const topic1072 = getUserRow(env, 1072)?.topic_id;
    reset();
    tgFailAll = { methods: ["forwardMessage", "copyMessage"], error: "Bad Gateway" };
    const rBoth = await webhook(env, privateMsg(1072, "两种方式都失败"));
    tgFailAll = null;
    check("转发与复制均失败时请求重投(500)", rBoth.status === 500, `status=${rBoth.status}`);
    check("均失败时不打送达标记", called("setMessageReaction").length === 0);
    check("均失败时不清空话题映射", getUserRow(env, 1072)?.topic_id === topic1072);
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

    // 含反斜杠的正则屏蔽词须原样显示：转义反斜杠会让管理员看到 &#92; 之类的乱码
    setCfgDirect(env, "block_keywords", JSON.stringify(["re:加微信\\d+"]));
    reset();
    await webhook(env, callback(900001, "panel:kw"));
    const kwPanel = tgCalls.find(c => String(c.body.text || "").includes("屏蔽词"));
    const kwBtns = JSON.stringify(kwPanel?.body.reply_markup || {});
    check("正则屏蔽词按原文显示", kwBtns.includes("加微信"), kwBtns.slice(0, 120));
    check("反斜杠未被转义成实体", !kwBtns.includes("&#92;"), kwBtns.slice(0, 120));
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
      }), env);

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

  // ---- user-verification: 不完成人机验证不得推进 ----
  section("user-verification：不点验证链接不得绕过人机验证");
  {
    // 问答关闭：绕过后会直接落到 verified
    const env = makeEnv();
    await webhook(env, privateMsg(1160, "/start"));
    setCfgDirect(env, "enable_captcha", "true");
    setCfgDirect(env, "enable_qa", "false");

    await webhook(env, privateMsg(1161, "/start"));
    check("已下发验证链接", getUserRow(env, 1161)?.state === "captcha_pending", `state=${getUserRow(env, 1161)?.state}`);

    reset();
    await webhook(env, privateMsg(1161, "我就不点那个链接"));
    check("不点链接直接发消息不得标记 verified",
      getUserRow(env, 1161)?.state !== "verified", `state=${getUserRow(env, 1161)?.state}`);
    check("该消息不被转发", called("forwardMessage").length === 0);
    check("重新下发验证入口",
      tgCalls.some(c => JSON.stringify(c.body.reply_markup || {}).includes("web_app")));

    // 问答开启：绕过后会落到 qa_pending
    const env2 = makeEnv();
    await webhook(env2, privateMsg(1162, "/start"));
    setCfgDirect(env2, "enable_captcha", "true");
    setCfgDirect(env2, "enable_qa", "true");
    setCfgDirect(env2, "qa_questions", JSON.stringify([{ id: "q1", q: "暗号？", a: "芝麻开门" }]));

    await webhook(env2, privateMsg(1163, "/start"));
    reset();
    await webhook(env2, privateMsg(1163, "跳过验证码试试"));
    check("不点链接不得跳到问答阶段",
      getUserRow(env2, 1163)?.state !== "qa_pending", `state=${getUserRow(env2, 1163)?.state}`);
    check("未收到题目", !sentTo(1163, "验证问题"));

    // 管理员关闭验证码后，卡在 captcha_pending 的用户须能脱困
    const env3 = makeEnv();
    await webhook(env3, privateMsg(1164, "/start"));
    setCfgDirect(env3, "enable_captcha", "true");
    setCfgDirect(env3, "enable_qa", "false");
    await webhook(env3, privateMsg(1165, "/start"));
    setCfgDirect(env3, "enable_captcha", "false"); // 管理员关闭人机验证
    reset();
    await webhook(env3, privateMsg(1165, "现在呢"));
    check("验证码关闭后待验证用户可脱困",
      getUserRow(env3, 1165)?.state === "verified", `state=${getUserRow(env3, 1165)?.state}`);

    // 重新下发验证入口时须复用未过期的 nonce，否则用户已打开的验证页会被判作废
    const env4 = makeEnv();
    await webhook(env4, privateMsg(1166, "/start"));
    setCfgDirect(env4, "enable_captcha", "true");
    setCfgDirect(env4, "enable_qa", "false");
    await webhook(env4, privateMsg(1167, "/start"));
    const nonceBefore = getUserRow(env4, 1167)?.verify_nonce;
    await webhook(env4, privateMsg(1167, "顺手又发一句"));
    check("重发验证入口复用未过期 nonce",
      getUserRow(env4, 1167)?.verify_nonce === nonceBefore, "已打开的验证页会失效");
  }

  // ---- 验证页 ----
  section("user-verification：验证页渲染");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1120, "/start"));
    const page = await worker.fetch(new Request("https://bot.example.workers.dev/verify?uid=1120&nonce=abc"), env);
    const html = await page.text();
    check("验证页返回 200", page.status === 200);
    check("默认渲染 Turnstile", html.includes("cf-turnstile") && html.includes("challenges.cloudflare.com"));

    setCfgDirect(env, "captcha_mode", "recaptcha");
    const page2 = await worker.fetch(new Request("https://bot.example.workers.dev/verify?uid=1120&nonce=abc"), env);
    const html2 = await page2.text();
    check("切换后渲染 reCAPTCHA", html2.includes("g-recaptcha") && html2.includes("google.com/recaptcha"));

    setCfgDirect(env, "enable_captcha", "false");
    const page3 = await worker.fetch(new Request("https://bot.example.workers.dev/verify?uid=1120&nonce=abc"), env);
    check("关闭验证码后拒绝访问", page3.status === 400);
  }

  // ---- 验证页参数注入 ----
  section("user-verification：验证页参数不可逃逸");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1170, "/start"));

    // 反斜杠吃掉闭合引号 → 让 nonce 的内容落到代码上下文
    const evilUid = encodeURIComponent("1\\");
    const evilNonce = encodeURIComponent(";PWNED();//");
    const p = await worker.fetch(
      new Request(`https://bot.example.workers.dev/verify?uid=${evilUid}&nonce=${evilNonce}`), env);
    const h = await p.text();

    // 从页面中取出注入行，交给真实 JS 解析器判定是否产生了可执行语句
    // 取整行（非贪婪匹配到首个 ; 会把 payload 截断，导致漏报）
    const line = (h.split("\n").find(l => l.includes("var UID")) || "").trim();
    let escaped = false;
    try {
      // 在沙箱里执行：PWNED 未定义，若逃逸成真会抛 ReferenceError
      new Function("var PWNED = function(){ throw new Error('XSS_EXECUTED'); };" + line)();
    } catch (e) {
      escaped = String(e.message).includes("XSS_EXECUTED");
    }
    check("反斜杠不能逃逸 JS 字符串上下文", !escaped, `line=${line}`);

    // </script> 向量
    const tagUid = encodeURIComponent("</script><img src=x onerror=alert(1)>");
    const p2 = await worker.fetch(
      new Request(`https://bot.example.workers.dev/verify?uid=${tagUid}&nonce=abc`), env);
    const h2 = await p2.text();
    check("尖括号不产生新标签", !h2.includes("<img src=x"), "页面出现了未转义的 img 标签");
    check("未提前闭合 script", !/<\/script>\s*<img/i.test(h2));
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

  // ---- update claim 与租约 ----
  section("topic-relay：update claim 与租约");

  // 建一个已完成验证、已有话题的用户，供本组各场景复用
  const claimEnv = async uidNum => {
    const env = makeEnv();
    await webhook(env, privateMsg(1200, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(uidNum, "/start"));
    await webhook(env, privateMsg(uidNum, "先建话题"));
    reset();
    return env;
  };

  {
    const env = await claimEnv(1201);
    const upd = { update_id: 90001, ...privateMsg(1201, "并发同一条") };
    await Promise.all([sendRawUpdate(env, upd), sendRawUpdate(env, upd)]);
    const n = delivered("forwardMessage").length;
    check("同一 update 并发只转发一次", n === 1, `forward=${n}`);
  }

  {
    // 临时失败返回 500 后，Telegram 用同一 update_id 重投，必须仍能送达。
    // forward 与 copy 都要注入失败：只失败 forward 会走既有的 copy 降级路径而成功。
    const env = await claimEnv(1202);
    const upd = { update_id: 90002, ...privateMsg(1202, "重投必须送达") };
    tgHooks = [
      { method: "forwardMessage", error_code: 502, description: "Bad Gateway" },
      { method: "copyMessage", error_code: 502, description: "Bad Gateway" }
    ];
    const r1 = await sendRawUpdate(env, upd);
    check("临时失败返回 500", r1.status === 500, `got ${r1.status}`);
    resetTgHooks();
    const r2 = await sendRawUpdate(env, upd);
    check("同一 update_id 重投返回 200", r2.status === 200, `got ${r2.status}`);
    check("重投最终送达", delivered("forwardMessage").length === 1,
      `delivered=${delivered("forwardMessage").length}`);
  }

  {
    // 模拟"取得处理权后 Worker 崩溃"：留下过期租约，重投必须能接管
    const env = await claimEnv(1203);
    env.TG_BOT_DB._raw
      .prepare("INSERT INTO processed_updates (update_id, ts, status, lease_until) VALUES (?,?,?,?)")
      .run("90003", Date.now(), "processing", Date.now() - 1000);
    const r = await sendRawUpdate(env, { update_id: 90003, ...privateMsg(1203, "租约过期可接管") });
    check("租约过期后可接管处理", r.status === 200 && delivered("forwardMessage").length === 1,
      `status=${r.status} delivered=${delivered("forwardMessage").length}`);
  }

  {
    // 他人租约未过期：必须交给重投，且不得并行产生副作用
    const env = await claimEnv(1204);
    env.TG_BOT_DB._raw
      .prepare("INSERT INTO processed_updates (update_id, ts, status, lease_until) VALUES (?,?,?,?)")
      .run("90004", Date.now(), "processing", Date.now() + 60_000);
    const r = await sendRawUpdate(env, { update_id: 90004, ...privateMsg(1204, "他人正在处理") });
    check("他人租约未过期返回 500", r.status === 500, `got ${r.status}`);
    check("他人租约未过期不产生副作用", called("forwardMessage").length === 0,
      `calls=${called("forwardMessage").length}`);
  }

  {
    // 已完成的 update 重投必须直接返回 200 且不重复副作用
    const env = await claimEnv(1205);
    const upd = { update_id: 90005, ...privateMsg(1205, "已完成的重投") };
    await sendRawUpdate(env, upd);
    const r = await sendRawUpdate(env, upd);
    check("终态 update 重投返回 200", r.status === 200, `got ${r.status}`);
    check("终态 update 重投不重复转发", delivered("forwardMessage").length === 1,
      `delivered=${delivered("forwardMessage").length}`);
  }

  // ---- 限流与重投解耦 ----
  section("topic-relay：限流与重投解耦");
  {
    const env = await claimEnv(1210);
    const upd = { update_id: 90010, ...privateMsg(1210, "限流窗口内的重投") };

    // 第一次投递：通过限流，但转发临时失败 → 500
    tgHooks = [
      { method: "forwardMessage", error_code: 502, description: "Bad Gateway" },
      { method: "copyMessage", error_code: 502, description: "Bad Gateway" }
    ];
    const r1 = await sendRawUpdate(env, upd);
    check("首投临时失败返回 500", r1.status === 500, `got ${r1.status}`);

    // 把限流桶填满：重投若重新计量就会被限流吞掉。
    // 当前与下一个时间窗都填满，避免测试恰好跨窗口而失去确定性。
    const bucket = Math.floor(Date.now() / 2000);
    for (const b of [bucket, bucket + 1]) {
      env.TG_BOT_DB._raw
        .prepare("INSERT INTO ratelimits (key, ts, count) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count")
        .run(`rl:1210:${b}`, Date.now(), 6);
    }

    resetTgHooks();
    reset();
    const r2 = await sendRawUpdate(env, upd);
    check("限流桶满时重投仍返回 200", r2.status === 200, `got ${r2.status}`);
    check("重投未被限流吞掉", delivered("forwardMessage").length === 1,
      `delivered=${delivered("forwardMessage").length}`);
    check("重投不发限流提示", !sentTo(1210, "过于频繁"));
  }

  // ---- Telegram 错误分类 ----
  section("topic-relay：Telegram 错误分类");
  {
    // 话题被关闭且重开持续 5xx：属于临时故障，不得清空映射
    const env = await claimEnv(1220);
    const topicBefore = getUserRow(env, 1220).topic_id;
    tgHooks = [
      { method: "forwardMessage", error_code: 400, description: "Bad Request: TOPIC_CLOSED" },
      { method: "copyMessage", error_code: 400, description: "Bad Request: TOPIC_CLOSED" },
      { method: "reopenForumTopic", error_code: 502, description: "Bad Gateway" }
    ];
    const r = await sendRawUpdate(env, { update_id: 90020, ...privateMsg(1220, "重开临时失败") });
    const topicAfter = getUserRow(env, 1220).topic_id;
    check("重开临时失败请求重投", r.status === 500, `got ${r.status}`);
    check("重开临时失败不清话题映射", topicAfter === topicBefore, `${topicBefore} -> ${topicAfter}`);
    resetTgHooks();
  }

  {
    // 话题被关闭且重开因权限（永久 4xx）失败：按删除处理，清映射后重建
    const env = await claimEnv(1221);
    const topicBefore = getUserRow(env, 1221).topic_id;
    tgHooks = [
      { method: "forwardMessage", error_code: 400, description: "Bad Request: TOPIC_CLOSED" },
      { method: "copyMessage", error_code: 400, description: "Bad Request: TOPIC_CLOSED" },
      { method: "reopenForumTopic", error_code: 400, description: "Bad Request: not enough rights" }
    ];
    await sendRawUpdate(env, { update_id: 90021, ...privateMsg(1221, "重开永久失败") });
    const topicAfter = getUserRow(env, 1221).topic_id;
    check("重开永久失败按删除处理", topicAfter === null, `topic=${topicAfter}`);
    resetTgHooks();
  }

  {
    // 管理员在话题内回复，copyMessage 持续 5xx：临时故障必须请求重投而不是吞掉
    const env = await claimEnv(1222);
    const topicId = getUserRow(env, 1222).topic_id;
    reset();
    tgHooks = [{ method: "copyMessage", error_code: 502, description: "Bad Gateway" }];
    const r = await sendRawUpdate(env, { update_id: 90022, ...groupMsg(900001, topicId, "管理员回复") });
    check("管理员回复临时失败请求重投", r.status === 500, `got ${r.status}`);
    resetTgHooks();

    // 重投后成功送达
    reset();
    const r2 = await sendRawUpdate(env, { update_id: 90022, ...groupMsg(900001, topicId, "管理员回复") });
    check("管理员回复重投后送达", r2.status === 200 && delivered("copyMessage").length === 1,
      `status=${r2.status} delivered=${delivered("copyMessage").length}`);
  }

  {
    // 用户停用机器人属于永久错误：在话题内提示，返回 200 不再重投
    const env = await claimEnv(1223);
    const topicId = getUserRow(env, 1223).topic_id;
    reset();
    tgHooks = [{ method: "copyMessage", error_code: 403, description: "Forbidden: bot was blocked by the user" }];
    const r = await sendRawUpdate(env, { update_id: 90023, ...groupMsg(900001, topicId, "发给已停用用户") });
    check("管理员回复永久失败返回 200", r.status === 200, `got ${r.status}`);
    resetTgHooks();
    check("永久失败在话题内提示", tgCalls.some(x =>
      x.method === "sendMessage" && String(x.body.text || "").includes("发送失败")));
  }

  // ---- 话题所有权 fencing ----
  section("topic-relay：话题所有权 fencing");
  {
    // 占位过期被接管后，原创建请求才返回：其结果不得覆盖接管者写入的映射
    const env = makeEnv();
    await webhook(env, privateMsg(1230, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1231, "/start"));
    reset();

    const gate = makeGate();
    tgHooks = [{ method: "createForumTopic", nth: 1, gate }];
    const slow = sendRawUpdate(env, { update_id: 90030, ...privateMsg(1231, "慢创建") });

    // 等第一次创建请求确实已进入挂起状态，再把占位改成过期，模拟持有者超时
    while (!tgCalls.some(x => x.method === "createForumTopic")) await new Promise(r => setTimeout(r, 5));
    env.TG_BOT_DB._raw.prepare("UPDATE users SET topic_claim_ts = ? WHERE user_id = ?")
      .run(Date.now() - 60_000, "1231");

    // 接管者创建成功并写入映射
    await sendRawUpdate(env, { update_id: 90031, ...privateMsg(1231, "接管创建") });
    const takenOver = getUserRow(env, 1231).topic_id;

    gate.open();
    await slow;
    const finalTopic = getUserRow(env, 1231).topic_id;
    check("过期持有者不覆盖接管者映射", finalTopic === takenOver, `${takenOver} -> ${finalTopic}`);
    resetTgHooks();
  }

  {
    // 针对旧话题的迟到失效错误，在新映射写入后返回：不得清空新映射。
    // 用闸门把转发失败挂在"错误已产生、尚未处理"的时刻，期间换掉映射，全程走真实路径。
    const env = await claimEnv(1232);
    const oldTopic = getUserRow(env, 1232).topic_id;
    const newTopic = oldTopic + 500;

    const gate = makeGate();
    tgHooks = [
      { method: "forwardMessage", nth: 1, gate, error_code: 400, description: "Bad Request: message thread not found" },
      { method: "copyMessage", error_code: 400, description: "Bad Request: message thread not found" }
    ];
    const inflight = sendRawUpdate(env, { update_id: 90032, ...privateMsg(1232, "迟到的失效错误") });

    while (!tgCalls.some(x => x.method === "forwardMessage")) await new Promise(r => setTimeout(r, 5));
    env.TG_BOT_DB._raw.prepare("UPDATE users SET topic_id = ? WHERE user_id = ?").run(newTopic, "1232");
    gate.open();
    await inflight;

    const after = getUserRow(env, 1232).topic_id;
    check("迟到失效错误不清新映射", after === newTopic, `${newTopic} -> ${after}`);
    resetTgHooks();
  }

  {
    // 黑名单共享话题：占位过期被接管后，原持有者的迟到写入不得生效。
    // 构造点在于接管者写入后话题又被删（值清回空）——只有 token 校验能挡住这次覆盖，
    // 仅靠"值为空才写"的条件会让孤儿话题号被写进去。
    const env = await claimEnv(1233);
    await webhook(env, privateMsg(1234, "/start"));
    await webhook(env, privateMsg(1234, "建话题"));
    reset();

    const gate = makeGate();
    tgHooks = [{ method: "createForumTopic", nth: 1, gate }];
    const slow = sendRawUpdate(env, { update_id: 90033, ...callback(900001, "block:1233") });

    while (!tgCalls.some(x => x.method === "createForumTopic")) await new Promise(r => setTimeout(r, 5));
    // 占位改成过期，让第二个屏蔽操作接管并写入共享话题号
    env.TG_BOT_DB._raw.prepare("UPDATE config SET value=? WHERE key='blacklist_topic_claim'")
      .run(String(Date.now() - 60_000));
    await sendRawUpdate(env, { update_id: 90034, ...callback(900001, "block:1234") });
    const takenOver = env.TG_BOT_DB._raw
      .prepare("SELECT value FROM config WHERE key='blacklist_topic_id'").all()[0].value;
    check("接管者成功创建共享话题", takenOver !== "" && takenOver !== undefined, `value=${takenOver}`);

    // 该话题随后被管理员删除，值清空
    env.TG_BOT_DB._raw.prepare("UPDATE config SET value='' WHERE key='blacklist_topic_id'").run();

    gate.open();
    await slow;
    const final = env.TG_BOT_DB._raw
      .prepare("SELECT value FROM config WHERE key='blacklist_topic_id'").all()[0].value;
    check("过期持有者的迟到写入不生效", final === "", `value=${final}`);
    resetTgHooks();
  }

  // ---- 编辑消息准入 ----
  section("topic-relay：编辑消息准入策略");
  {
    // /reset 后编辑旧消息不得绕过验证
    const env = await claimEnv(1240);
    reset();
    await webhook(env, groupMsg(900001, null, "/reset 1240"));
    await webhook(env, privateMsg(900001, "/reset 1240"));
    check("重置后状态非 verified", getUserRow(env, 1240).state !== "verified",
      `state=${getUserRow(env, 1240).state}`);

    reset();
    await webhook(env, { edited_message: privateMsg(1240, "重置后编辑").message });
    check("重置后编辑不进管理群", !tgCalls.some(x =>
      String(x.body.chat_id) === "-1001234567890" && String(x.body.text || "").includes("修改了消息")));
    check("重置后编辑收到验证引导", tgCalls.some(x =>
      String(x.body.chat_id) === "1240" && String(x.body.text || "").length > 0));
  }

  {
    // 编辑为含屏蔽关键字的内容不得转达
    const env = await claimEnv(1241);
    setCfgDirect(env, "block_keywords", JSON.stringify(["违禁词"]));
    reset();
    await webhook(env, { edited_message: privateMsg(1241, "这里有违禁词").message });
    check("编辑含屏蔽词不转达", !tgCalls.some(x =>
      String(x.body.chat_id) === "-1001234567890" && String(x.body.text || "").includes("修改了消息")));
    check("编辑含屏蔽词给出拦截提示", sentTo(1241, "违禁词") || sentTo(1241, "拦截"));
  }

  {
    // 被屏蔽用户的编辑同样不得转达（既有行为，防回归）
    const env = await claimEnv(1242);
    env.TG_BOT_DB._raw.prepare("UPDATE users SET is_blocked=1 WHERE user_id='1242'").run();
    reset();
    await webhook(env, { edited_message: privateMsg(1242, "被屏蔽后编辑").message });
    check("被屏蔽用户编辑不转达", !tgCalls.some(x =>
      String(x.body.chat_id) === "-1001234567890" && String(x.body.text || "").includes("修改了消息")));
  }

  // ---- 初始资料卡按钮 ----
  section("moderation：初始置顶资料卡管理入口");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1250, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1251, "/start"));
    reset();
    await webhook(env, privateMsg(1251, "触发建话题"));

    const card = tgCalls.find(x =>
      x.method === "sendMessage" && String(x.body.text || "").includes("用户资料"));
    const btns = JSON.stringify(card?.body?.reply_markup || {});
    check("初始资料卡带屏蔽按钮", btns.includes("block:1251"), btns);
    check("初始资料卡带备注按钮", btns.includes("notehelp"), btns);
  }

  {
    // 直接点击初始资料卡上的屏蔽按钮即可屏蔽
    const env = makeEnv();
    await webhook(env, privateMsg(1252, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1253, "/start"));
    await webhook(env, privateMsg(1253, "触发建话题"));
    reset();
    await webhook(env, callback(900001, "block:1253"));
    check("点击初始卡屏蔽按钮生效", getUserRow(env, 1253).is_blocked === 1,
      `is_blocked=${getUserRow(env, 1253).is_blocked}`);
  }

  // ---- 正则安全子集 ----
  section("keyword-filter：正则安全子集");
  {
    const env = await claimEnv(1260);
    // 恶意样本：量词链与转义括号分组，都是当前黑名单能绕过的写法。
    // 量词链取 k=24（实测未防护时单次匹配约 12.8 秒）
    const evil = [
      "re:" + "a?".repeat(24) + "a".repeat(24) + "$",
      "re:(?:a|aa|\\))+$"
    ];
    const attack = "a".repeat(400) + "b";

    for (const pat of evil) {
      setCfgDirect(env, "block_keywords", JSON.stringify([pat]));
      reset();
      const t0 = Date.now();
      await webhook(env, privateMsg(1260, attack));
      const cost = Date.now() - t0;
      check(`危险模式被拒且不卡顿 ${pat.slice(0, 20)}`, cost < 1000, `cost=${cost}ms`);
      check(`危险模式视为不匹配 ${pat.slice(0, 20)}`, delivered("forwardMessage").length === 1,
        `delivered=${delivered("forwardMessage").length}`);
    }
  }

  {
    // 常规写法必须继续生效
    const env = await claimEnv(1261);
    const cases = [
      ["re:加微信\\d+", "快来加微信12345", true],
      ["re:[Vv][Xx]\\s*[:：]?\\s*\\w+", "vx：abc123", true],
      ["re:客服\\s*QQ\\s*\\d{5,}", "客服QQ 123456", true],
      ["re:加微信\\d+", "这是一条正常消息", false]
    ];
    for (const [pat, text, shouldBlock] of cases) {
      setCfgDirect(env, "block_keywords", JSON.stringify([pat]));
      reset();
      await webhook(env, privateMsg(1261, text));
      const blocked = delivered("forwardMessage").length === 0;
      check(`${pat} 对「${text}」${shouldBlock ? "拦截" : "放行"}`, blocked === shouldBlock,
        `blocked=${blocked}`);
    }
  }

  {
    // 被拒条目必须在面板中标示为未生效
    const env = makeEnv();
    await webhook(env, privateMsg(900001, "/start"));
    setCfgDirect(env, "block_keywords", JSON.stringify(["广告", "re:(?:a|aa|\\))+$"]));
    reset();
    await webhook(env, callback(900001, "panel:kw"));
    const panel = tgCalls.find(x => String(x.body.text || "").includes("屏蔽词"));
    check("面板提示存在未生效规则", String(panel?.body?.text || "").includes("不生效"),
      String(panel?.body?.text || "").slice(0, 120));
    check("被拒条目按钮标未生效",
      JSON.stringify(panel?.body?.reply_markup || {}).includes("未生效"),
      JSON.stringify(panel?.body?.reply_markup || {}).slice(0, 200));
  }

  // ---- 验证流程收敛 ----
  section("user-verification：问答开关与 nonce 原子性");
  {
    // 用户处于 qa_pending 时管理员关闭问答（题库保留），用户应立即脱困
    const env = makeEnv();
    await webhook(env, privateMsg(1270, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "true");
    setCfgDirect(env, "qa_questions", JSON.stringify([{ id: "q1", q: "1+1=?", a: "2" }]));
    await webhook(env, privateMsg(1271, "/start"));
    check("用户处于问答待答", getUserRow(env, 1271).state === "qa_pending",
      `state=${getUserRow(env, 1271).state}`);

    // 关闭问答但保留题库
    setCfgDirect(env, "enable_qa", "false");
    reset();
    await webhook(env, privateMsg(1271, "随便一条普通消息"));
    check("关闭问答后立即脱困", getUserRow(env, 1271).state === "verified",
      `state=${getUserRow(env, 1271).state}`);
    check("关闭问答后不再发题目", !sentTo(1271, "1+1=?"));
  }

  {
    // 同一 nonce 的两个提交并发到达：至多一个推进验证
    const env = makeEnv();
    await webhook(env, privateMsg(1272, "/start"));
    setCfgDirect(env, "enable_captcha", "true");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1273, "/start"));
    const nonce = getUserRow(env, 1273).verify_nonce;
    check("已下发 nonce", !!nonce, `nonce=${nonce}`);

    reset();
    const initData = makeInitData(1273);
    const submit = () =>
      worker.fetch(
        new Request("https://bot.example.workers.dev/submit_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: "1273", nonce, token: "tok", initData })
        }),
        env
      );
    const rs = await Promise.all([submit(), submit()]);
    const bodies = await Promise.all(rs.map(r => r.json()));
    // 两个请求都可以返回 ok（第二个是幂等成功），真正的不变量是只推进一次验证
    check("并发同 nonce 不报错", bodies.every(j => j.ok === true), JSON.stringify(bodies));
    check("并发同 nonce 只推进一次验证", tgCalls.filter(x =>
      String(x.body.text || "").includes("验证通过")).length === 1,
      `count=${tgCalls.filter(x => String(x.body.text || "").includes("验证通过")).length}`);
    check("nonce 已被消费", !getUserRow(env, 1273).verify_nonce);
  }

  {
    // 并发触发验证入口下发：先前已下发且未过期的 nonce 仍可成功提交
    const env = makeEnv();
    await webhook(env, privateMsg(1274, "/start"));
    setCfgDirect(env, "enable_captcha", "true");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1275, "/start"));
    const first = getUserRow(env, 1275).verify_nonce;

    // 并发再触发两次入口下发
    await Promise.all([
      sendRawUpdate(env, { update_id: 90040, ...privateMsg(1275, "再来一条") }),
      sendRawUpdate(env, { update_id: 90041, ...privateMsg(1275, "又一条") })
    ]);
    const after = getUserRow(env, 1275).verify_nonce;
    check("并发下发不作废已有 nonce", after === first, `${first} -> ${after}`);

    // 用户手上那张页面（持 first）此时仍必须能成功提交——这才是"不互相作废"的真正含义
    reset();
    const r = await worker.fetch(
      new Request("https://bot.example.workers.dev/submit_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: "1275", nonce: first, token: "tok", initData: makeInitData(1275) })
      }),
      env
    );
    check("并发下发后原 nonce 仍可提交", r.status === 200 && getUserRow(env, 1275).state === "verified",
      `status=${r.status} state=${getUserRow(env, 1275).state}`);
  }

  // ---- 欢迎语语义 ----
  section("admin-panel：欢迎语纯文本语义");
  {
    // 未验证用户不发 /start 直接发普通消息，也应收到欢迎语
    const env = makeEnv();
    await webhook(env, privateMsg(1280, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "welcome_msg", "欢迎 {name}");
    reset();
    await webhook(env, privateMsg(1281, "你好我想咨询"));
    check("首条普通消息也发欢迎语", sentTo(1281, "欢迎"),
      JSON.stringify(tgCalls.map(x => x.body.text)).slice(0, 200));
  }

  {
    // 同一验证过程中不重复轰炸欢迎语
    const env = makeEnv();
    await webhook(env, privateMsg(1282, "/start"));
    setCfgDirect(env, "enable_captcha", "true");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "welcome_msg", "欢迎 {name}");
    reset();
    await webhook(env, privateMsg(1283, "第一条"));
    await webhook(env, privateMsg(1283, "第二条"));
    const n = tgCalls.filter(x => String(x.body.text || "").includes("欢迎")).length;
    check("欢迎语不重复轰炸", n === 1, `count=${n}`);
  }

  {
    // 含尖括号的纯文本欢迎语必须原样送达，不因解析失败而丢失
    const env = makeEnv();
    await webhook(env, privateMsg(1284, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "welcome_msg", "欢迎 <老板> & 朋友");
    reset();
    await webhook(env, privateMsg(1285, "/start"));
    const w = tgCalls.find(x => String(x.body.text || "").includes("欢迎"));
    check("尖括号欢迎语被转义后发送",
      String(w?.body?.text || "").includes("&lt;老板&gt;") && String(w?.body?.text || "").includes("&amp;"),
      String(w?.body?.text || ""));
  }

  {
    // 媒体欢迎语发送失败不得回退为发送内部 JSON
    const env = makeEnv();
    await webhook(env, privateMsg(1286, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    setCfgDirect(env, "welcome_msg", JSON.stringify({ type: "photo", file_id: "FID123", caption: "欢迎 {name}" }));
    reset();
    tgHooks = [{ method: "sendPhoto", error_code: 400, description: "Bad Request: wrong file identifier" }];
    await webhook(env, privateMsg(1287, "/start"));
    resetTgHooks();
    const leaked = tgCalls.some(x => String(x.body.text || "").includes("file_id"));
    check("媒体失败不泄露内部 JSON", !leaked,
      JSON.stringify(tgCalls.map(x => x.body.text)).slice(0, 200));
    check("媒体失败仍发出欢迎文案", sentTo(1287, "欢迎"),
      JSON.stringify(tgCalls.map(x => x.body.text)).slice(0, 200));
  }

  // ---- 配置并发写入 ----
  section("admin-panel：配置并发写入");
  {
    // 两个管理员并发添加不同屏蔽词，都确认保存 → 两者都必须存在
    const env = makeEnv();
    await webhook(env, privateMsg(900001, "/start"));
    setCfgDirect(env, "block_keywords", JSON.stringify([]));
    reset();
    await Promise.all([
      (async () => {
        await sendRawUpdate(env, { update_id: 90050, ...callback(900001, "panel:input:kw_add") });
        await sendRawUpdate(env, { update_id: 90051, ...privateMsg(900001, "词甲") });
      })(),
      (async () => {
        await sendRawUpdate(env, { update_id: 90052, ...callback(900001, "panel:input:kw_add") });
        await sendRawUpdate(env, { update_id: 90053, ...privateMsg(900001, "词乙") });
      })()
    ]);
    const list = JSON.parse(env.TG_BOT_DB._raw
      .prepare("SELECT value FROM config WHERE key='block_keywords'").all()[0].value);
    const names = list.map(x => (typeof x === "string" ? x : x.kw));
    check("并发添加两条都保留", names.includes("词甲") && names.includes("词乙"), JSON.stringify(list));
  }

  // ---- 重投重放：写入已生效但后续步骤失败时不得重复副作用 ----
  // 三处根因相同：claim 只防同一 update 的并发重复处理，不防 500 后的重投重放，
  // 排在失败点之前的每个不可重放副作用都会再执行一遍。
  section("admin-panel：重投不重复追加列表条目");
  {
    for (const [field, input, key, label] of [
      ["kw_add", "违禁词甲", "block_keywords", "屏蔽词"],
      ["ar_add", "价格===请联系客服", "auto_replies", "自动回复"],
      ["qa_add", "1+1=?===2", "qa_questions", "问答题"]
    ]) {
      const env = makeEnv();
      await webhook(env, privateMsg(900001, "/start"));
      await webhook(env, callback(900001, `panel:input:${field}`));

      // 条目写入后、清除输入态前失败 → 500 → Telegram 重投同一 update_id
      const upd = { update_id: 91000 + label.length * 7, ...privateMsg(900001, input) };
      reset();
      armD1(/DELETE FROM config/i, 1);
      const r1 = await sendRawUpdate(env, upd);
      disarmD1();
      const r2 = await sendRawUpdate(env, upd);
      const list = JSON.parse(env.TG_BOT_DB._raw
        .prepare("SELECT value FROM config WHERE key=?").all(key)[0]?.value || "[]");
      check(`${label}：清状态失败时请求重投(500)`, r1.status === 500, `status=${r1.status}`);
      check(`${label}：重投后条目仍只有一条`, list.length === 1,
        `重投=${r2.status} 条目=${JSON.stringify(list)}`);
    }

    // 内容相同但属两次独立操作的条目都要保留：幂等键取 update 身份而非内容
    const env2 = makeEnv();
    await webhook(env2, privateMsg(900001, "/start"));
    await webhook(env2, callback(900001, "panel:input:ar_add"));
    await webhook(env2, privateMsg(900001, "价格===客服A"));
    await webhook(env2, callback(900001, "panel:input:ar_add"));
    await webhook(env2, privateMsg(900001, "价格===客服A"));
    const ars = JSON.parse(env2.TG_BOT_DB._raw
      .prepare("SELECT value FROM config WHERE key='auto_replies'").all()[0]?.value || "[]");
    check("内容相同的两次独立添加都保留", ars.length === 2, `条目=${ars.length}`);
    check("两条 id 不同", ars.length === 2 && ars[0].id !== ars[1].id,
      `ids=${ars.map(x => x.id).join(",")}`);
  }

  section("user-verification：重投不重复发欢迎语");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1290, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");

    // 欢迎语已发出后，推进验证状态的写入失败 → 重投重放整条处理链
    reset();
    const upd = { update_id: 91500, ...privateMsg(1291, "/start") };
    armD1(/UPDATE users SET state=/i, 1);
    const r1 = await sendRawUpdate(env, upd);
    disarmD1();
    const r2 = await sendRawUpdate(env, upd);
    check("验证写失败时请求重投(500)", r1.status === 500, `status=${r1.status}`);
    check("重投后欢迎语只发一次", countSentTo(1291, "欢迎") === 1,
      `重投=${r2.status} 欢迎语=${countSentTo(1291, "欢迎")}`);
    check("重投后用户仍完成验证",
      getUserRow(env, 1291)?.state === "verified", `state=${getUserRow(env, 1291)?.state}`);

    // 未验证用户再发一次 /start 仍应收到欢迎语：幂等键是 update 身份，不是"发过就不再发"
    const env2 = makeEnv();
    await webhook(env2, privateMsg(1292, "/start"));
    setCfgDirect(env2, "enable_captcha", "false");
    setCfgDirect(env2, "enable_qa", "true");
    setCfgDirect(env2, "qa_questions", JSON.stringify([{ id: "q1", q: "1+1=?", a: "2" }]));
    reset();
    await webhook(env2, privateMsg(1293, "/start"));
    await webhook(env2, privateMsg(1293, "/start"));
    check("未验证用户重发 /start 仍收到欢迎语", countSentTo(1293, "欢迎") === 2,
      `欢迎语=${countSentTo(1293, "欢迎")} state=${getUserRow(env2, 1293)?.state}`);
  }

  section("moderation：黑名单卡片不产生孤儿");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1295, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1296, "/start"));
    await webhook(env, privateMsg(1296, "建话题"));

    // 自动封禁已建卡后，管理员再点资料卡上那颗尚未刷新的"屏蔽"按钮
    setCfgDirect(env, "block_keywords", JSON.stringify(["违禁"]));
    setCfgDirect(env, "block_threshold", "1");
    reset();
    await webhook(env, privateMsg(1296, "违禁内容"));
    await webhook(env, callback(900001, "block:1296"));
    const cards = tgCalls.filter(x => x.method === "sendMessage" &&
      String(x.body.text || "").includes("用户已屏蔽"));
    check("自动封禁后再点屏蔽不新建卡片", cards.length === 1, `新建=${cards.length}`);

    // 解封必须能删掉那张唯一的卡片，且清空 id
    reset();
    await webhook(env, callback(900001, "unblock:1296"));
    check("解封删除黑名单卡片", called("deleteMessage").length === 1,
      `删除=${called("deleteMessage").length}`);
    check("解封后 blacklist_msg_id 清空", !getUserRow(env, 1296)?.blacklist_msg_id,
      `id=${getUserRow(env, 1296)?.blacklist_msg_id}`);

    // 解封后再屏蔽应重新建卡（id 已清空，不能因"曾经有过"而不建）
    reset();
    await webhook(env, callback(900001, "block:1296"));
    const again = tgCalls.filter(x => x.method === "sendMessage" &&
      String(x.body.text || "").includes("用户已屏蔽"));
    check("解封后再屏蔽重新建卡", again.length === 1, `新建=${again.length}`);
  }

  {
    // 条目已被他人删除后再点原删除按钮：不得误删其他条目
    const env = makeEnv();
    await webhook(env, privateMsg(900001, "/start"));
    setCfgDirect(env, "block_keywords", JSON.stringify(["甲", "乙", "丙"]));
    reset();
    // 管理员 A 看到的是索引 0（"甲"）的删除按钮
    await webhook(env, callback(900001, "panel:kw"));
    const panel = tgCalls.find(x => String(x.body.text || "").includes("屏蔽词"));
    const firstBtn = panel.body.reply_markup.inline_keyboard[0][0].callback_data;

    // 管理员 B 先删掉了"甲"
    await webhook(env, callback(900001, firstBtn));
    // 管理员 A 此时才点自己那个已过期的按钮
    await webhook(env, callback(900001, firstBtn));

    const list = JSON.parse(env.TG_BOT_DB._raw
      .prepare("SELECT value FROM config WHERE key='block_keywords'").all()[0].value);
    const names = list.map(x => (typeof x === "string" ? x : x.kw));
    check("过期删除不误删他项", names.includes("乙") && names.includes("丙"), JSON.stringify(list));
  }

  {
    // 并发切换两个不同开关，两者的新状态都必须持久化
    const env = makeEnv();
    await webhook(env, privateMsg(900001, "/start"));
    setCfgDirect(env, "allow_sticker", "true");
    setCfgDirect(env, "allow_audio", "true");
    reset();
    await Promise.all([
      sendRawUpdate(env, { update_id: 90054, ...callback(900001, "panel:toggle:allow_sticker:filter") }),
      sendRawUpdate(env, { update_id: 90055, ...callback(900001, "panel:toggle:allow_audio:filter") })
    ]);
    const get = k => env.TG_BOT_DB._raw.prepare("SELECT value FROM config WHERE key=?").all(k)[0]?.value;
    check("并发切换两个开关都生效", get("allow_sticker") === "false" && get("allow_audio") === "false",
      `sticker=${get("allow_sticker")} audio=${get("allow_audio")}`);
  }

  {
    // 回滚要求：屏蔽词必须保持裸字符串数组。
    // 若改成 {id, kw} 对象，旧版代码会把元素直接交给 matchKeyword，
    // 退化成 "[object Object]" 参与匹配，全部屏蔽词失效。
    const env = makeEnv();
    await webhook(env, privateMsg(900001, "/start"));
    setCfgDirect(env, "block_keywords", JSON.stringify([]));
    reset();
    await webhook(env, callback(900001, "panel:input:kw_add"));
    await webhook(env, privateMsg(900001, "测试词"));
    const list = JSON.parse(env.TG_BOT_DB._raw
      .prepare("SELECT value FROM config WHERE key='block_keywords'").all()[0].value);
    check("屏蔽词保持裸字符串结构", list.every(x => typeof x === "string"), JSON.stringify(list));
  }

  // ---- schema 迁移幂等性 ----
  section("schema：迁移幂等与数据保留");
  {
    const env = makeEnv();
    await webhook(env, privateMsg(1160, "/start"));
    setCfgDirect(env, "enable_captcha", "false");
    setCfgDirect(env, "enable_qa", "false");
    await webhook(env, privateMsg(1161, "/start"));
    await webhook(env, privateMsg(1161, "建话题"));

    const raw = env.TG_BOT_DB._raw;
    const before = raw.prepare("SELECT user_id, state, topic_id FROM users ORDER BY user_id").all();
    const cfgBefore = raw.prepare("SELECT key, value FROM config ORDER BY key").all();
    check("迁移前已有话题映射", before.some(u => u.topic_id != null));

    const cols = t => raw.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    check("processed_updates 有 status", cols("processed_updates").includes("status"));
    check("processed_updates 有 lease_until", cols("processed_updates").includes("lease_until"));
    check("processed_updates 有 claim_token", cols("processed_updates").includes("claim_token"));
    check("users 有 topic_claim_token", cols("users").includes("topic_claim_token"));
    check("config 有 version", cols("config").includes("version"));

    // 存量行必须被解释为终态，否则其 update_id 的重投会被误判为"他人正在处理"
    raw.prepare("INSERT INTO processed_updates (update_id, ts) VALUES ('legacy-1', ?)").run(Date.now());
    const legacy = raw.prepare("SELECT status FROM processed_updates WHERE update_id='legacy-1'").all()[0];
    check("存量 processed_updates 行视为 done", legacy.status === "done", `status=${legacy.status}`);

    // 换一个绑定对象指向同一个库，绕过按绑定缓存，真实地再跑一遍迁移
    const env2 = { ...env, TG_BOT_DB: makeD1(raw) };
    let migrateErr = null;
    try {
      await webhook(env2, privateMsg(1161, "迁移后再发一条"));
    } catch (e) {
      migrateErr = e;
    }
    check("重复迁移不报错", migrateErr === null, String(migrateErr));

    const after = raw.prepare("SELECT user_id, state, topic_id FROM users ORDER BY user_id").all();
    const cfgAfter = raw.prepare("SELECT key, value FROM config ORDER BY key").all();
    check("迁移后用户与话题映射不变", JSON.stringify(after) === JSON.stringify(before),
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    check("迁移后配置值不变", JSON.stringify(cfgAfter) === JSON.stringify(cfgBefore));
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
