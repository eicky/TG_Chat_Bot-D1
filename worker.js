/**
 * Telegram 双向联系机器人 — Cloudflare Worker + D1
 *
 * 部署：Dashboard 粘贴本文件 → 绑定 D1（变量名 TG_BOT_DB）→ 配置环境变量 → 添加 Cron 触发器 → setWebhook
 *
 * 并发设计（替代旧版"抢锁 + sleep 轮询 + 释放协议"）：
 * webhook 同步处理完再响应，响应码即控制流——200 表示处理完毕，500 请求 Telegram 稍后重投。
 * 话题创建只用一条原子条件 UPDATE 占位，没抢到的请求不轮询、不 sleep，直接返回 500，
 * 把等待完全外包给 Telegram 自带的重投退避；重投到达时话题通常已就绪。
 *
 * 需要的环境变量：
 *   BOT_TOKEN, ADMIN_IDS, ADMIN_GROUP_ID, WORKER_URL, TELEGRAM_WEBHOOK_SECRET,
 *   TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, RECAPTCHA_SITE_KEY, RECAPTCHA_SECRET_KEY
 */

// ============================================================
// §1 常量与默认配置
// ============================================================

const DEFAULTS = {
  welcome_msg: "👋 欢迎 {name}！\n请先完成验证，之后即可与管理员对话。",

  // 验证
  enable_captcha: "true",
  captcha_mode: "turnstile", // turnstile | recaptcha
  enable_qa: "true",
  qa_questions: "[]", // [{id, q, a}]

  // 风控
  block_threshold: "5",
  block_keywords: "[]", // ["广告", "re:加微信\\d+"]
  auto_replies: "[]", // [{id, kw, reply}]

  // 转发类型开关
  allow_forward: "true",
  allow_audio: "true",
  allow_sticker: "true",
  allow_media: "true",
  allow_link: "true",
  allow_channel: "true",
  allow_text: "true",

  // 营业状态
  busy_mode: "false",
  busy_msg: "当前为非营业时间，消息已收到，管理员稍后回复。",

  // 共享话题
  blacklist_topic_id: ""
};

// 话题创建占位：超过此时长视为持有者已挂，允许其他请求接管
const TOPIC_CLAIM_STALE_MS = 30_000;

// 验证 nonce 有效期
const NONCE_TTL_MS = 15 * 60_000;
// initData 签名有效期（秒）
const INITDATA_MAX_AGE_SEC = 600;

// 私聊消息限流
const RL_USER_WINDOW_MS = 2_000;
const RL_USER_MAX = 6;
// 验证提交限流
const RL_SUBMIT_WINDOW_MS = 60_000;
const RL_SUBMIT_MAX = 10;
// 提示防抖窗口（屏蔽提示、限流提示）
const RL_NOTICE_WINDOW_MS = 10_000;
// 营业状态忙碌提示冷却
const BUSY_REPLY_COOLDOWN_MS = 5 * 60_000;

// Cron 清理保留期
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60_000;
const RATELIMIT_TTL_MS = 10 * 60_000;

// 配置 CAS 冲突重试次数：面板操作是人工触发的低频写入，
// 同一键上同时有 3 个以上写者属于异常，超过就明确报失败而不是无限重试
const CFG_CAS_RETRIES = 3;

// update 处理租约：持有期内其他 isolate 不得处理同一 update，到期后允许接管。
// 取值依据：单次处理最多串联两个 Telegram 调用（forward 失败降级 copy），
// 每个调用的总等待上限是 TG_TOTAL_WAIT_CAP_MS（10 秒），故正常处理不超过 20 秒；
// 取 30 秒留出 D1 往返余量，既不会误接管仍在处理的 update，
// 也远小于 Telegram 的重投退避上限，崩溃后不会长时间卡住消息。
const UPDATE_LEASE_MS = 30_000;

// Telegram API 重试
const TG_MAX_RETRIES = 3;
const TG_BACKOFF_MS = [200, 500, 1200];
const TG_TOTAL_WAIT_CAP_MS = 10_000;

// 正则安全（ReDoS 缓解）：模式必须落在 isSafeRegexSubset 定义的安全子集内，
// 下面几个上限是子集之外的二次防线
const RE_MAX_PATTERN_LEN = 256;
const RE_MAX_TEXT_LEN = 512;
// 量词总数上限（`?` 也计入，旧实现漏计 `?` 正是绕过点之一）。
// 安全子集排除了分组与交替，但单字符量词链 `a?a?…aⁿ$` 仍指数回溯：
// 在 512 字符文本上实测 k=14 耗时 7ms、k=16 为 31ms、k=20 为 642ms、k=24 为 12.8 秒。
// 取 8 使最坏情况停留在亚毫秒级，同时覆盖常规写法——
// 如 re:[Vv][Xx]\s*[:：]?\s*\w+ 量词数为 4，re:客服\s*QQ\s*\d{5,} 为 3。
const RE_MAX_QUANTIFIERS = 8;

// 消息已送达用户话题后给原消息打的回应
const DELIVERED_REACTION = "👍";

// 转发消息到话题失败时的错误分类：话题被删 / 话题被关 / 其他临时故障
const ERR_TOPIC_GONE = /thread not found|TOPIC_DELETED|topic.*not found/i;
const ERR_TOPIC_CLOSED = /TOPIC_CLOSED|topic.*closed/i;

// 处理链中抛出它表示"本次处理未完成，请 Telegram 稍后重投"（入口转为 HTTP 500）
class RetryLater extends Error {}

// ============================================================
// §2 入口路由
// ============================================================

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    try {
      if (req.method === "GET") {
        if (url.pathname === "/verify") return await handleVerifyPage(url, env);
        if (url.pathname === "/") return new Response("Bot is running.", { status: 200 });
        return new Response("Not Found", { status: 404 });
      }

      if (req.method === "POST") {
        // 验证页回调：不带 webhook secret，安全性由 initData 验签保证
        if (url.pathname === "/submit_token") return await handleTokenSubmit(req, env);

        if (url.pathname !== "/" && url.pathname !== "/webhook") {
          return new Response("Not Found", { status: 404 });
        }

        // 拒绝非 Telegram 请求
        if (!verifyWebhookSecret(req, env)) return new Response("Forbidden", { status: 403 });

        let update;
        try {
          update = await req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        return await processUpdate(update, env);
      }
    } catch (e) {
      console.error("Worker error:", e?.stack || e?.message || e);
      return new Response("Internal Server Error", { status: 500 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },

  // Cron 触发：清理过期辅助数据（旧版靠 now % 97 概率触发，时机不可控且耦合在业务路径里）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  }
};

/**
 * 同步处理一条 update，用响应码表达结果：
 *   200 = 处理完毕或已去重；500 = 未完成，请 Telegram 按退避重投
 * 副作用前先原子取得处理权（claim），成功后才写终态，
 * 因此并发的同一 update 只有一个执行副作用，而失败路径仍可被重投接管。
 *
 * 重放约定（claim 不防重投）：claim 只挡住同一 update_id 的并发重复处理；
 * Telegram 因 500 重投整条 update 时，整段逻辑会从头重放。故任何不可逆副作用
 * 必须满足二者之一——(a) 排在该处理路径最后一个可能抛错的点之后；
 * (b) 把幂等键绑定到 update_id，使重放被识别为同一次（见 entryId、sendWelcomeOnce）。
 */
async function processUpdate(update, env) {
  const updateId = update?.update_id;
  if (updateId === undefined || updateId === null) return new Response("OK");

  const c = newCtx(env);
  await ensureSchema(env);

  const claim = await claimUpdate(c, updateId);
  if (claim.state === "done") return new Response("OK");
  // 他人租约未过期：交给重投而不是并行处理，避免重复副作用
  if (claim.state === "busy") return new Response("Busy", { status: 500 });

  // 把 update 身份带进上下文：限流等"每 update 至多计量一次"的决策依赖它
  c.updateId = updateId;
  c.claimToken = claim.token;
  c.rlDecision = claim.rlDecision;

  try {
    await dispatch(c, update);
  } catch (e) {
    // 释放处理权：重投可立即接管，无需等租约自然到期
    await releaseUpdate(c, updateId, claim.token);
    if (e instanceof RetryLater) {
      return new Response("Retry later", { status: 500 });
    }
    console.error("Dispatch failed:", e?.stack || e?.message || e);
    // 未知异常同样交给重投，避免消息静默丢失
    return new Response("Error", { status: 500 });
  }

  await finishUpdate(c, updateId, claim.token);
  return new Response("OK");
}

/** 按 update 归属分发到私聊 / 管理群 / 回调三条路径 */
async function dispatch(c, update) {
  if (update.callback_query) return handleCallback(c, update.callback_query);

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

  const isEdit = !!update.edited_message;

  if (msg.chat.type === "private") {
    if (isEdit) return handleEditedMessage(c, msg);
    return handlePrivate(c, msg);
  }

  if (String(msg.chat.id) === String(c.env.ADMIN_GROUP_ID)) {
    if (isEdit) return; // 管理员编辑自己的消息无需处理
    return handleGroupMessage(c, msg);
  }
}

// ============================================================
// §3 D1 访问层
// ============================================================

// 建表只需成功一次；DDL 幂等，此处按 D1 绑定缓存仅为避免每请求重复执行
const schemaReady = new WeakMap();

function ensureSchema(env) {
  const binding = env.TG_BOT_DB;
  if (!binding) return Promise.reject(new Error("D1 binding TG_BOT_DB is missing"));

  let p = schemaReady.get(binding);
  if (!p) {
    p = createTables(env).catch(e => {
      schemaReady.delete(binding); // 失败不缓存，下次请求重试
      throw e;
    });
    schemaReady.set(binding, p);
  }
  return p;
}

async function createTables(env) {
  await env.TG_BOT_DB.batch([
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      user_id            TEXT PRIMARY KEY,
      state              TEXT    NOT NULL DEFAULT 'new',
      is_blocked         INTEGER NOT NULL DEFAULT 0,
      strike_count       INTEGER NOT NULL DEFAULT 0,
      topic_id           INTEGER,
      topic_claim_ts     INTEGER,
      name               TEXT,
      username           TEXT,
      note               TEXT,
      verify_nonce       TEXT,
      nonce_issued_at    INTEGER,
      qa_question_id     TEXT,
      card_msg_id        INTEGER,
      blacklist_msg_id   INTEGER,
      last_busy_reply_at INTEGER,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    )`),
    // 话题 → 用户的反查依赖此索引；唯一约束同时防止两个用户指向同一话题
    env.TG_BOT_DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_topic ON users(topic_id) WHERE topic_id IS NOT NULL`
    ),
    env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    env.TG_BOT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS processed_updates (update_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)`
    ),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_processed_ts ON processed_updates(ts)`),
    env.TG_BOT_DB.prepare(
      `CREATE TABLE IF NOT EXISTS ratelimits (key TEXT PRIMARY KEY, ts INTEGER NOT NULL, count INTEGER NOT NULL)`
    ),
    env.TG_BOT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ratelimits_ts ON ratelimits(ts)`)
  ]);

  await migrateSchema(env);
}

/**
 * 增量列清单：[表, 列, 列定义]。
 * 建表语句本身不含这些列，新库与老库都走同一条迁移路径，避免两条路径产生不同的表结构。
 */
const SCHEMA_ADDITIONS = [
  // processed_updates 由「布尔已处理标记」升级为「claim + 租约 + 终态」。
  // status 默认 'done'：迁移前的存量行都是处理完成后才写入的，必须被解释为终态，
  // 否则会被当成"正在处理"而让对应 update 的重投一直被拒。
  ["processed_updates", "status", "TEXT NOT NULL DEFAULT 'done'"],
  ["processed_updates", "lease_until", "INTEGER"],
  ["processed_updates", "claim_token", "TEXT"],
  // 该 update 的限流决策（'pass' | 'limited'）：重投时复用，避免重复消耗额度
  ["processed_updates", "rl_decision", "TEXT"],
  // 话题占位的所有权标识：写回 topic_id 时校验自己仍是占位持有者（fencing）
  ["users", "topic_claim_token", "TEXT"],
  // 最近一次发出欢迎语所属的 update_id：欢迎语走 tgQuiet 不抛错，
  // 但它之后的验证状态写入会抛，重投时整段重放会让用户收到第二条欢迎语。
  // 记录 update 身份即可把"同一条消息的重投"与"用户再发一次 /start"区分开。
  ["users", "welcome_update_id", "TEXT"],
  // 配置写入的 CAS 版本号，用于多管理员并发修改时检测覆盖
  ["config", "version", "INTEGER NOT NULL DEFAULT 0"]
];

async function tableColumns(env, table) {
  // 表名来自上面的常量清单，不含外部输入，故可直接插值（PRAGMA 不支持参数绑定）
  const r = await env.TG_BOT_DB.prepare(`PRAGMA table_info(${table})`).all();
  return (r?.results || []).map(x => x.name);
}

async function migrateSchema(env) {
  for (const [table, column, decl] of SCHEMA_ADDITIONS) {
    if ((await tableColumns(env, table)).includes(column)) continue;
    try {
      await env.TG_BOT_DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`).run();
    } catch (e) {
      // 两个 isolate 可能同时探测到缺列并同时 ALTER，后者会失败。
      // 重新确认列确实已存在才算成功，避免把真实的迁移失败也吞掉。
      if (!(await tableColumns(env, table)).includes(column)) throw e;
    }
  }
}

/**
 * 每个请求一个上下文：配置在请求内 memoize，请求间不缓存。
 * 旧版的跨请求 isolate 缓存会让面板显示别的 isolate 的过期状态，这里从根上避免。
 * update 身份（updateId/claimToken/rlDecision）随上下文传递，用于把限流决策绑定到具体 update。
 */
function newCtx(env) {
  return { env, _cfg: null, _admins: null, updateId: null, claimToken: null, rlDecision: null };
}

const db = env => env.TG_BOT_DB;

async function dbAll(c, q, args = []) {
  const r = await db(c.env).prepare(q).bind(...args).all();
  return r?.results || [];
}

async function dbFirst(c, q, args = []) {
  return await db(c.env).prepare(q).bind(...args).first();
}

async function dbRun(c, q, args = []) {
  const r = await db(c.env).prepare(q).bind(...args).run();
  return r?.meta?.changes ?? 0;
}

// --- 配置读写 ---

async function loadConfig(c) {
  if (c._cfg) return c._cfg;
  const rows = await dbAll(c, "SELECT key, value FROM config");
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  c._cfg = map;
  return map;
}

async function cfg(c, key) {
  const map = await loadConfig(c);
  if (map[key] !== undefined) return map[key];
  return DEFAULTS[key] ?? "";
}

async function cfgBool(c, key) {
  return (await cfg(c, key)) === "true";
}

async function cfgJson(c, key, fallback = []) {
  return safeParse(await cfg(c, key), fallback);
}

async function setCfg(c, key, value) {
  await dbRun(
    c,
    `INSERT INTO config (key, value, version) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = config.version + 1`,
    [key, String(value)]
  );
  if (c._cfg) c._cfg[key] = String(value);
}

/**
 * 基于 version 的 CAS 更新：读取当前值与版本，让 mutate 计算新值，
 * 只有版本未变时才写入；冲突则重读重放，有限次重试。
 *
 * 直接 setCfg 是"读-改-写"，两个管理员并发修改同一个列表时后写者会用自己的
 * 旧快照覆盖对方的修改，被确认保存的条目凭空消失。CAS 把冲突变成可检测、可重放。
 *
 * mutate 接收解析后的当前值，返回要写入的新值；返回 undefined 表示放弃本次修改
 * （例如要删除的条目已被他人删掉）。返回 true 表示写入成功，false 表示重试耗尽。
 */
async function updateCfgCas(c, key, mutate, retries = CFG_CAS_RETRIES) {
  for (let i = 0; i < retries; i++) {
    const row = await dbFirst(c, "SELECT value, version FROM config WHERE key = ?", [key]);
    const curValue = row ? row.value : (DEFAULTS[key] ?? "");
    const curVersion = row ? Number(row.version || 0) : null;

    const next = await mutate(curValue);
    if (next === undefined) return false; // 意图已不适用，不写入

    let changes;
    if (curVersion === null) {
      // 行不存在：靠 INSERT OR IGNORE 的原子性决定谁先建行，失败者下一轮走 UPDATE 分支
      changes = await dbRun(c, "INSERT OR IGNORE INTO config (key, value, version) VALUES (?, ?, 1)", [
        key,
        String(next)
      ]);
    } else {
      changes = await dbRun(c, "UPDATE config SET value = ?, version = version + 1 WHERE key = ? AND version = ?", [
        String(next),
        key,
        curVersion
      ]);
    }

    if (changes > 0) {
      c._cfg = null; // 值已变更，作废本请求内的 memoize
      return true;
    }
    // 影响 0 行 = 版本已被他人推进，下一轮重读重放
  }
  return false;
}

/** 列表类配置的 CAS 修改；mutate 接收数组、返回新数组或 undefined 放弃 */
async function updateCfgListCas(c, key, mutate) {
  return updateCfgCas(c, key, raw => {
    const list = safeParse(raw, []);
    const next = mutate(Array.isArray(list) ? list : []);
    return next === undefined ? undefined : JSON.stringify(next);
  });
}

async function delCfg(c, key) {
  await dbRun(c, "DELETE FROM config WHERE key = ?", [key]);
  if (c._cfg) delete c._cfg[key];
}

// --- 用户读写 ---

const USER_COLUMNS = new Set([
  "state",
  "is_blocked",
  "strike_count",
  "topic_id",
  "topic_claim_ts",
  "name",
  "username",
  "note",
  "verify_nonce",
  "nonce_issued_at",
  "qa_question_id",
  "card_msg_id",
  "blacklist_msg_id",
  "last_busy_reply_at",
  "welcome_update_id"
]);

async function getUser(c, userId) {
  const uid = String(userId);
  let row = await dbFirst(c, "SELECT * FROM users WHERE user_id = ?", [uid]);
  if (!row) {
    const now = Date.now();
    await dbRun(c, "INSERT OR IGNORE INTO users (user_id, created_at, updated_at) VALUES (?, ?, ?)", [uid, now, now]);
    row = await dbFirst(c, "SELECT * FROM users WHERE user_id = ?", [uid]);
  }
  return normalizeUser(row, uid);
}

function normalizeUser(row, uid) {
  if (!row) {
    return { user_id: String(uid), state: "new", is_blocked: false, strike_count: 0, topic_id: null };
  }
  row.is_blocked = !!row.is_blocked;
  row.user_id = String(row.user_id);
  return row;
}

/** 只允许写白名单列，值按列语义归一（布尔转 0/1） */
async function updUser(c, userId, patch) {
  const keys = Object.keys(patch).filter(k => USER_COLUMNS.has(k));
  if (!keys.length) return 0;

  const sets = keys.map(k => `${k}=?`).join(", ");
  const vals = keys.map(k => {
    const v = patch[k];
    return typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v;
  });
  return await dbRun(c, `UPDATE users SET ${sets}, updated_at=? WHERE user_id=?`, [...vals, Date.now(), String(userId)]);
}

/** 话题 → 用户反查（管理员在话题内回复时定位目标用户） */
async function getUserByTopic(c, topicId) {
  const row = await dbFirst(c, "SELECT * FROM users WHERE topic_id = ?", [Number(topicId)]);
  return row ? normalizeUser(row, row.user_id) : null;
}

// --- update claim / 租约 / 终态 ---

/**
 * 取得 update 的处理权。返回：
 *   { state: "done" }                          已处理完毕，调用方直接返回 200
 *   { state: "busy" }                          他人租约未过期，调用方返回 500 交重投，不得执行副作用
 *   { state: "claimed", token, rlDecision }    本次持有处理权，可以执行副作用
 *
 * 处理权与终态分两步写：若在处理前就写终态，Worker 崩溃会让消息永久丢失；
 * 若不写处理中标记，并发的同一 update 会各自执行一遍副作用。租约兼顾两者。
 * rlDecision 是该 update 首次计量得出的限流结论，接管者复用它而不重新计量。
 */
async function claimUpdate(c, updateId) {
  const id = String(updateId);
  const now = Date.now();
  const token = genNonce(16);

  const inserted = await dbRun(
    c,
    `INSERT OR IGNORE INTO processed_updates (update_id, ts, status, lease_until, claim_token)
     VALUES (?, ?, 'processing', ?, ?)`,
    [id, now, now + UPDATE_LEASE_MS, token]
  );
  if (inserted > 0) return { state: "claimed", token, rlDecision: null };

  // 已存在：要么已完成，要么他人正在处理。租约过期才允许接管，
  // 条件里带上原 claim_token 保证两个接管者只有一个成功。
  const row = await dbFirst(
    c,
    "SELECT status, lease_until, claim_token, rl_decision FROM processed_updates WHERE update_id = ?",
    [id]
  );
  if (!row || row.status === "done") return { state: "done" };

  if (Number(row.lease_until || 0) > now) return { state: "busy" };

  const taken = await dbRun(
    c,
    `UPDATE processed_updates SET claim_token = ?, lease_until = ?, ts = ?
      WHERE update_id = ? AND status = 'processing' AND lease_until = ?
        AND (claim_token IS ? OR claim_token = ?)`,
    [token, now + UPDATE_LEASE_MS, now, id, Number(row.lease_until || 0), row.claim_token ?? null, row.claim_token ?? null]
  );
  return taken > 0
    ? { state: "claimed", token, rlDecision: row.rl_decision || null }
    : { state: "busy" };
}

/** 写入终态；条件带 token，避免把被他人接管后的处理结果错误地标记为完成 */
async function finishUpdate(c, updateId, token) {
  try {
    await dbRun(
      c,
      "UPDATE processed_updates SET status = 'done', claim_token = NULL, lease_until = NULL, ts = ? WHERE update_id = ? AND claim_token = ?",
      [Date.now(), String(updateId), token]
    );
  } catch {
    // 终态写失败最多导致一次重复处理，不值得让已成功送达的消息失败
  }
}

/**
 * 处理失败时释放处理权，让重投能立刻接管而不必等租约到期。
 * 释放而非删除记录：保留行可承载与该 update 绑定的决策（如限流计量结果）。
 */
async function releaseUpdate(c, updateId, token) {
  try {
    await dbRun(
      c,
      "UPDATE processed_updates SET lease_until = 0 WHERE update_id = ? AND claim_token = ? AND status = 'processing'",
      [String(updateId), token]
    );
  } catch {
    // 释放失败只是让重投多等一个租约周期，不影响正确性
  }
}

// --- 限流 / 防抖桶 ---

/**
 * 原子桶计数：同一时间窗口内的第 N 次调用返回 N。
 * 兼作限流与提示防抖（返回 1 表示"本窗口第一次"，可以发提示）。
 */
async function bumpBucket(c, name, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const key = `${name}:${bucket}`;
  const row = await dbFirst(
    c,
    `INSERT INTO ratelimits (key, ts, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = ratelimits.count + 1, ts = excluded.ts
     RETURNING count`,
    [key, Date.now()]
  );
  return Number(row?.count || 1);
}

/** 返回 true 表示本次应当发送提示（窗口内首次） */
async function shouldNotify(c, name) {
  return (await bumpBucket(c, name, RL_NOTICE_WINDOW_MS)) === 1;
}

/**
 * 限流判定，结果与 update 身份绑定：同一 update 只在首次处理时消耗额度，
 * 重投复用首次结论。否则一条因临时故障返回 500 的消息，重投时会再次消耗额度，
 * 在窗口已满的情况下被限流吞掉——把"临时故障"变成"永久丢失"。
 * 返回 true 表示应当限流拦截。
 */
async function rateLimited(c, uid) {
  if (c.rlDecision) return c.rlDecision === "limited";

  const decision = (await bumpBucket(c, `rl:${uid}`, RL_USER_WINDOW_MS)) > RL_USER_MAX ? "limited" : "pass";
  c.rlDecision = decision;

  if (c.updateId !== null && c.claimToken) {
    // 条件带 token：本次处理若已被他人接管，不覆盖接管者的决策
    await dbRun(c, "UPDATE processed_updates SET rl_decision = ? WHERE update_id = ? AND claim_token = ?", [
      decision,
      String(c.updateId),
      c.claimToken
    ]);
  }
  return decision === "limited";
}

async function runCleanup(env) {
  const c = newCtx(env);
  await ensureSchema(env);
  const now = Date.now();
  await dbRun(c, "DELETE FROM processed_updates WHERE ts < ?", [now - PROCESSED_TTL_MS]);
  await dbRun(c, "DELETE FROM ratelimits WHERE ts < ?", [now - RATELIMIT_TTL_MS]);
}

// ============================================================
// §4 Telegram Bot API 客户端
// ============================================================

/**
 * 429 按 retry_after 等待、5xx 与网络异常指数退避；总等待封顶保证 webhook 不超时。
 * 失败抛错，由调用方决定是降级、忽略还是转为 RetryLater。
 */
async function tg(c, method, body) {
  const token = c.env.BOT_TOKEN;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    let delay = TG_BACKOFF_MS[Math.min(attempt, TG_BACKOFF_MS.length - 1)];
    let lastErr;

    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => null);

      if (d && d.ok) return d.result;

      const code = d?.error_code ?? r.status;
      lastErr = new Error(d?.description || `TG API error ${code}`);
      // 保留结构化错误信息：classifyTgError 需要 error_code 才能区分
      // "永久 4xx" 与 "限流/5xx 临时故障"，仅靠 description 文本无法可靠判定
      lastErr.tgErrorCode = code;
      lastErr.tgDescription = d?.description || "";

      if (code === 429) {
        const ra = Number(d?.parameters?.retry_after || 0);
        delay = Math.min(5000, Math.max(200, ra ? ra * 1000 : delay));
        retryable = true;
      } else if (code >= 500) {
        retryable = true;
      }
    } catch (e) {
      lastErr = e;
      if (lastErr && lastErr.tgErrorCode === undefined) lastErr.tgNetwork = true; // 区分网络异常与 API 返回的错误
      retryable = true; // 网络异常
    }

    const canRetry = retryable && attempt < TG_MAX_RETRIES && waited + delay <= TG_TOTAL_WAIT_CAP_MS;
    if (!canRetry) throw lastErr;

    waited += delay;
    await sleep(delay);
  }
}

/** 发送失败不影响主流程的调用（提示、卡片刷新、reaction 等） */
async function tgQuiet(c, method, body) {
  try {
    return await tg(c, method, body);
  } catch (e) {
    if (method !== "setMessageReaction") console.warn(`TG ${method} failed:`, e?.message || e);
    return null;
  }
}

/**
 * Telegram 错误统一分类，所有需要据此决策的调用方都用它，避免各处正则判断不一致：
 *   topic_gone   话题已删除 → 条件清映射后重投
 *   topic_closed 话题已关闭 → 先尝试重开
 *   transient    429 / 5xx / 网络异常 → 状态不变，请求重投
 *   permanent    其他 4xx（含 403 用户停用）→ 终止处理，给出可见提示
 *
 * 顺序上先判临时性再判文本：限流响应里也可能带话题相关字样，
 * 若先按文本判为 topic_gone 就会把"稍后重试即可"误判成"话题没了"并清空映射。
 */
function classifyTgError(err) {
  const code = err?.tgErrorCode;
  const msg = String(err?.tgDescription || err?.message || "");

  if (err?.tgNetwork || code === undefined) return "transient";
  if (code === 429 || code >= 500) return "transient";

  if (ERR_TOPIC_CLOSED.test(msg)) return "topic_closed";
  if (ERR_TOPIC_GONE.test(msg)) return "topic_gone";

  return "permanent";
}

const sendText = (c, chatId, text, extra = {}) =>
  tgQuiet(c, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra
  });

// ============================================================
// §5 安全原语
// ============================================================

function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function verifyWebhookSecret(req, env) {
  const expected = String(env.TELEGRAM_WEBHOOK_SECRET || "");
  if (!expected) return false; // 未配置 secret 时一律拒绝，避免裸奔
  return timingSafeEqual(req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", expected);
}

/**
 * 校验 Telegram Mini App 的 initData 签名。
 * 用户身份以此结果为准——客户端传来的 userId 不可信。
 */
async function verifyInitData(initData, botToken, maxAgeSec = INITDATA_MAX_AGE_SEC) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!hash) throw new Error("missing hash");

  const authDate = parseInt(params.get("auth_date") || "", 10);
  if (!Number.isFinite(authDate)) throw new Error("missing auth_date");
  if (maxAgeSec && Math.floor(Date.now() / 1000) - authDate > maxAgeSec) throw new Error("initData expired");

  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();

  const secret = await hmac(new TextEncoder().encode("WebAppData"), new TextEncoder().encode(botToken));
  const sig = await hmac(secret, new TextEncoder().encode(pairs.join("\n")));
  if (!timingSafeEqual(toHex(sig), hash.toLowerCase())) throw new Error("hash mismatch");

  let user = null;
  try {
    const raw = params.get("user");
    if (raw) user = JSON.parse(raw);
  } catch {}
  if (!user?.id) throw new Error("missing user");

  return { userId: String(user.id), user, authDate };
}

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function genNonce(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

// ============================================================
// §6 工具函数
// ============================================================

function safeParse(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 把值安全地嵌入 <script> 内的 JS 字符串上下文。
 * 用 JSON.stringify 处理引号与反斜杠（HTML 转义函数做不了这件事：
 * 它不转义反斜杠，而 \ 能吃掉闭合引号让后续内容变成代码）。
 * 但 JSON.stringify 不管 HTML，`</script>` 会提前闭合脚本元素，故额外转义 `<`。
 */
function jsLiteral(v) {
  return JSON.stringify(String(v ?? "")).replace(/</g, "\\u003c");
}

function esc(t) {
  return String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function displayName(user) {
  const n = `${user?.first_name || ""} ${user?.last_name || ""}`.trim();
  return n || user?.username || "用户";
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function getAdminSet(c) {
  if (c._admins) return c._admins;
  c._admins = new Set(
    String(c.env.ADMIN_IDS || "")
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean)
  );
  return c._admins;
}

function isAdmin(c, userId) {
  return getAdminSet(c).has(String(userId));
}

// ============================================================
// §7 过滤引擎：关键词匹配 + 消息类型判定
// ============================================================

/**
 * 安全子集校验：按字符扫描模式，只接受可控回溯的写法。
 * 返回 true 表示模式在子集内，可以安全编译执行。
 *
 * 接受：字面字符、转义序列、字符类 `[...]`、锚点 `^ $`，
 *       以及只作用于「单个字符或单个字符类」的量词 `* + ? {m,n}`。
 * 拒绝：分组 `( )`（含 `(?:`）、作用于分组的量词、连续量词、
 *       反向引用 `\1`、前后行断言、`|` 交替。
 *
 * 为什么改成解析而不是继续加黑名单：黑名单按字符串形态匹配，无法理解转义。
 * `(?:a|aa|\))+$` 里的 `\)` 是字面右括号，字符串规则会误认为分组已闭合而放行，
 * 实测单次匹配耗时超过 20 秒。解析器逐字符处理转义，不存在这种误判。
 *
 * 排除分组与交替消灭了 `(a|aa)+` 这类分支组合爆炸，但仅此不够：
 * 单字符量词链 `a?a?…aⁿ$` 同样指数回溯，故还要限量词总数，见 RE_MAX_QUANTIFIERS。
 */
function isSafeRegexSubset(src) {
  let i = 0;
  const n = src.length;
  let lastAtomQuantifiable = false; // 上一个已解析单元是否可被量词修饰
  let quantifiers = 0;

  while (i < n) {
    const ch = src[i];

    if (ch === "\\") {
      if (i + 1 >= n) return false; // 悬空反斜杠
      const next = src[i + 1];
      if (next >= "1" && next <= "9") return false; // 反向引用
      i += 2;
      lastAtomQuantifiable = true;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "|") return false; // 分组与交替

    if (ch === "[") {
      // 字符类整体是一个原子；内部逐字符扫描以正确跳过转义的 `]`
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++; // 首位的 `]` 是字面量
      while (j < n && src[j] !== "]") {
        if (src[j] === "\\") j++;
        j++;
      }
      if (j >= n) return false; // 未闭合
      i = j + 1;
      lastAtomQuantifiable = true;
      continue;
    }

    if (ch === "]") return false; // 无对应开头的字符类结束符

    if (ch === "*" || ch === "+" || ch === "?") {
      // 量词必须紧跟一个可修饰的原子；连续量词（`a**`、`a+?`）一律拒绝，
      // 避免嵌套量词语义与惰性修饰带来的额外分析负担
      if (!lastAtomQuantifiable) return false;
      if (++quantifiers > RE_MAX_QUANTIFIERS) return false;
      i++;
      lastAtomQuantifiable = false;
      continue;
    }

    if (ch === "{") {
      const close = src.indexOf("}", i);
      if (close < 0) return false;
      const body = src.slice(i + 1, close);
      if (!/^\d+(,\d*)?$/.test(body)) return false; // 非区间写法不视为量词
      if (!lastAtomQuantifiable) return false;
      if (++quantifiers > RE_MAX_QUANTIFIERS) return false;
      i = close + 1;
      lastAtomQuantifiable = false;
      continue;
    }

    if (ch === "^" || ch === "$") {
      i++;
      lastAtomQuantifiable = false; // 锚点不可被量词修饰
      continue;
    }

    // 普通字面字符
    i++;
    lastAtomQuantifiable = true;
  }

  return true;
}

/**
 * 关键词匹配：默认小写子串；`re:` 前缀走正则。
 * 旧版把所有条目都当正则执行，普通词也白白承担 ReDoS 面，这里只有显式声明才进正则分支。
 * 不在安全子集内的模式视为不匹配（面板会标示为未生效），而不是报错中断其余条目。
 */
function matchKeyword(pattern, text, foldedText = String(text ?? "").toLowerCase()) {
  const p = String(pattern ?? "").trim();
  const t = String(text ?? "");
  if (!p || !t) return false;

  if (!p.startsWith("re:")) return foldedText.includes(p.toLowerCase());

  const src = p.slice(3).trim();
  if (!isValidRePattern(src)) return false;

  try {
    // 截断被检文本：安全子集已排除指数回溯，这里作为二次防线限制多项式规模
    return new RegExp(src, "i").test(t.slice(0, RE_MAX_TEXT_LEN));
  } catch {
    return false; // 非法正则视为不匹配，不影响其余条目
  }
}

/** `re:` 模式是否可安全生效：长度上限 + 安全子集 + 能被引擎编译 */
function isValidRePattern(src) {
  if (!src || src.length > RE_MAX_PATTERN_LEN) return false;
  if (!isSafeRegexSubset(src)) return false;
  try {
    new RegExp(src, "i");
    return true;
  } catch {
    return false;
  }
}

function matchAny(patterns, text, foldedText) {
  return (Array.isArray(patterns) ? patterns : []).some(p => matchKeyword(p, text, foldedText));
}

/**
 * 消息类型判定链：取首个命中的类型，查对应开关。
 * 频道来源的转发单独判定，可与普通转发分别控制。
 */
const MSG_TYPES = [
  {
    name: "转发消息",
    hit: m => !!(m.forward_from || m.forward_from_chat || m.forward_origin),
    key: m => {
      const isChannel = m.forward_from_chat?.type === "channel" || m.forward_origin?.chat?.type === "channel";
      return isChannel ? "allow_channel" : "allow_forward";
    }
  },
  { name: "语音/音频", hit: m => !!(m.voice || m.audio), key: () => "allow_audio" },
  { name: "贴纸/GIF", hit: m => !!(m.sticker || m.animation), key: () => "allow_sticker" },
  { name: "媒体文件", hit: m => !!(m.photo || m.video || m.document || m.video_note), key: () => "allow_media" },
  {
    name: "链接",
    hit: m => (m.entities || m.caption_entities || []).some(e => e.type === "url" || e.type === "text_link"),
    key: () => "allow_link"
  },
  { name: "纯文本", hit: m => !!m.text, key: () => "allow_text" }
];

/** 返回被拦截的类型名；null 表示放行 */
async function blockedTypeName(c, msg) {
  for (const t of MSG_TYPES) {
    if (!t.hit(msg)) continue;
    return (await cfgBool(c, t.key(msg))) ? null : t.name;
  }
  return null;
}

// ============================================================
// §8 验证流
// ============================================================

/** 当前生效的验证码模式；关闭时返回 null */
async function captchaMode(c) {
  if (!(await cfgBool(c, "enable_captcha"))) return null;
  return (await cfg(c, "captcha_mode")) === "recaptcha" ? "recaptcha" : "turnstile";
}

async function activeQaBank(c) {
  if (!(await cfgBool(c, "enable_qa"))) return [];
  const bank = await cfgJson(c, "qa_questions", []);
  return Array.isArray(bank) ? bank : []; // 空题库等效关闭，否则用户会被堵死在无题可答的状态
}

/** 向验证码服务商校验 token */
async function siteverify(c, mode, token) {
  if (!token) return false;

  const isRecaptcha = mode === "recaptcha";
  const url = isRecaptcha
    ? "https://www.google.com/recaptcha/api/siteverify"
    : "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const secret = isRecaptcha ? c.env.RECAPTCHA_SECRET_KEY : c.env.TURNSTILE_SECRET_KEY;
  if (!secret) return false;

  try {
    // reCAPTCHA 只接受 form 编码，Turnstile 接受 JSON
    const init = isRecaptcha
      ? {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret, response: token })
        }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret, response: token })
        };
    const r = await fetch(url, init);
    const d = await r.json();
    return !!d?.success;
  } catch (e) {
    console.warn("siteverify failed:", e?.message || e);
    return false;
  }
}

/**
 * 把用户推进到下一验证阶段。
 * 顺序固定：人机验证 → 问答 → 已验证；关闭的环节被跳过。
 *
 * captchaSatisfied 由调用方显式声明「本次请求确实完成了人机验证」。
 * 不能靠 user.state === "captcha_pending" 反推：那只表示验证入口已下发，
 * 用户不点链接直接发下一条消息时该状态同样成立，据此推进等于放行未验证用户。
 */
async function advanceVerification(c, user, captchaSatisfied = false) {
  const uid = user.user_id;
  const mode = await captchaMode(c);

  // qa_pending / verified 是人机验证之后的状态，能到达就说明该环节已通过
  const captchaDone = captchaSatisfied || user.state === "qa_pending" || user.state === "verified";
  if (mode && !captchaDone) return sendCaptchaStep(c, uid, user);

  // 问答一律走 activeQaBank：管理员中途关闭问答或清空题库时，
  // 已在 qa_pending 的用户也能脱困，不会被永久堵在无题可答的状态
  const bank = await activeQaBank(c);
  if (bank.length) return sendQaQuestion(c, uid, false, bank);
  return markVerified(c, uid);
}

async function sendCaptchaStep(c, uid, user = null) {
  const base = String(c.env.WORKER_URL || "").replace(/\/+$/, "");
  if (!base) {
    // 没配 WORKER_URL 就无法承载验证页，跳过人机验证而不是把用户堵死
    console.error("WORKER_URL is not configured; skipping captcha");
    const bank = await activeQaBank(c);
    if (bank.length) return sendQaQuestion(c, uid, false, bank);
    return markVerified(c, uid);
  }

  // 复用尚未过期的 nonce：用户打开验证页后又发消息会重新走到这里，
  // 每次都换新 nonce 会让他手上那张已打开的页面提交时被判作废。
  const issuedAt = Number(user?.nonce_issued_at || 0);
  const reusable = user?.verify_nonce && Date.now() - issuedAt <= NONCE_TTL_MS;
  const nonce = reusable ? user.verify_nonce : genNonce();

  const patch = { state: "captcha_pending" };
  if (!reusable) {
    patch.verify_nonce = nonce;
    patch.nonce_issued_at = Date.now();
  }
  await updUser(c, uid, patch);

  const url = `${base}/verify?uid=${encodeURIComponent(uid)}&nonce=${encodeURIComponent(nonce)}`;
  await sendText(c, uid, "🛡️ <b>安全验证</b>\n请点击下方按钮完成人机验证。", {
    reply_markup: { inline_keyboard: [[{ text: "🔐 点击验证", web_app: { url } }]] }
  });
}

/**
 * 随机抽一题并记录题目 id：判定只认这道题的答案，
 * 否则脚本背熟任意一题答案就能通吃，随机抽题就失去意义了。
 */
async function sendQaQuestion(c, uid, isRetry, parsedBank = null) {
  const bank = parsedBank ?? (await cfgJson(c, "qa_questions", []));
  if (!Array.isArray(bank) || !bank.length) return markVerified(c, uid);

  const q = pickRandom(bank);
  await updUser(c, uid, { state: "qa_pending", qa_question_id: String(q.id) });

  const prefix = isRetry ? "❌ 答案错误，请回答：\n" : "❓ <b>验证问题</b>\n";
  await sendText(c, uid, prefix + esc(q.q));
}

async function markVerified(c, uid) {
  await updUser(c, uid, { state: "verified", verify_nonce: null, nonce_issued_at: null, qa_question_id: null });
  await sendText(c, uid, "✅ 验证通过！\n现在可以直接发送消息联系管理员。");
}

/**
 * 处理问答阶段的输入。
 * 返回 true 表示已按答案处理；false 表示应交上层按命令处理。
 *
 * 题库一律取 activeQaBank：它会先查 enable_qa 开关。
 * 直接读 qa_questions 会让"关闭问答但保留题库"的用户继续被判题，
 * 答对才能脱困——开关等于没生效。
 */
async function handleQaAnswer(c, user, text) {
  const input = String(text || "").trim();
  const bank = await activeQaBank(c);

  if (!bank.length) {
    await markVerified(c, user.user_id);
    return true;
  }

  const current = bank.find(q => String(q.id) === String(user.qa_question_id));
  if (!current) {
    // 当前题被管理员删了：重新抽题，不判用户错
    await sendQaQuestion(c, user.user_id, false, bank);
    return true;
  }

  if (input === String(current.a ?? "").trim()) {
    await markVerified(c, user.user_id);
    return true;
  }

  // 命令不判错：否则用户在题目改动后无法用 /start 自救
  if (input.startsWith("/")) return false;

  // 答错换题：题库越大，脚本枚举成本越高
  await sendQaQuestion(c, user.user_id, true, bank);
  return true;
}

/** 管理员 /reset：回到未验证并作废 nonce，不动屏蔽状态与话题映射 */
async function resetUserVerification(c, uid) {
  await updUser(c, uid, {
    state: "new",
    verify_nonce: null,
    nonce_issued_at: null,
    qa_question_id: null
  });
}

// ============================================================
// §9 验证页与提交端点
// ============================================================

async function handleVerifyPage(url, env) {
  const c = newCtx(env);
  await ensureSchema(env);

  const uid = url.searchParams.get("uid") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const mode = await captchaMode(c);
  if (!mode) return new Response("验证当前已关闭。", { status: 400 });

  const siteKey = mode === "recaptcha" ? env.RECAPTCHA_SITE_KEY : env.TURNSTILE_SITE_KEY;
  if (!uid || !siteKey) return new Response("验证配置不完整。", { status: 400 });

  const scriptSrc =
    mode === "recaptcha"
      ? "https://www.google.com/recaptcha/api.js"
      : "https://challenges.cloudflare.com/turnstile/v0/api.js";
  const widgetClass = mode === "recaptcha" ? "g-recaptcha" : "cf-turnstile";

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全验证</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<script src="${scriptSrc}" async defer></script>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--tg-theme-bg-color,#fff);
       color:var(--tg-theme-text-color,#000)}
  .box{text-align:center;padding:24px;max-width:92vw}
  h3{margin:0 0 18px}
  #msg{margin-top:14px;min-height:22px;font-size:15px}
</style></head>
<body><div class="box">
  <h3>🛡️ 安全验证</h3>
  <div class="${widgetClass}" data-sitekey="${esc(siteKey)}" data-callback="onVerified"></div>
  <div id="msg"></div>
</div>
<script>
  var tg = window.Telegram.WebApp; tg.ready(); tg.expand();
  var UID = ${jsLiteral(uid)}, NONCE = ${jsLiteral(nonce)};
  function onVerified(token){
    document.getElementById('msg').textContent = '验证中…';
    fetch('/submit_token', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: token, uid: UID, nonce: NONCE, initData: tg.initData || ''})
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok) {
        document.getElementById('msg').textContent = '✅ 验证成功，正在返回…';
        setTimeout(function(){ tg.close(); }, 800);
      } else {
        document.getElementById('msg').textContent = '❌ 验证失败：' + ((d && d.error) || '请返回重试');
      }
    }).catch(function(){ document.getElementById('msg').textContent = '❌ 网络错误，请重试'; });
  }
</script></body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

/**
 * 验证提交：验签前置，失败零存储副作用。
 * 身份取自 initData 验签结果，客户端传的 uid 只用于一致性核对。
 */
async function handleTokenSubmit(req, env) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad request" }, 400);
  }

  // 先验签：无有效签名的请求在此终止，不触发任何 D1 读写
  let identity;
  try {
    identity = await verifyInitData(String(body?.initData || ""), env.BOT_TOKEN);
  } catch (e) {
    return json({ ok: false, error: "invalid initData" }, 403);
  }

  const uid = identity.userId;
  if (body?.uid && String(body.uid) !== uid) return json({ ok: false, error: "uid mismatch" }, 403);

  const c = newCtx(env);
  await ensureSchema(env);

  if ((await bumpBucket(c, `submit:${uid}`, RL_SUBMIT_WINDOW_MS)) > RL_SUBMIT_MAX) {
    return json({ ok: false, error: "too many attempts" }, 429);
  }

  const user = await getUser(c, uid);
  if (user.is_blocked) return json({ ok: false, error: "blocked" }, 403);
  if (user.state === "verified") return json({ ok: true });

  const mode = await captchaMode(c);
  if (!mode) {
    // 验证码在用户打开页面后被关闭：直接推进，不让用户卡住
    await advanceVerification(c, user, true);
    return json({ ok: true });
  }

  // nonce 一次性：用条件更新原子消费。
  // 旧实现先读快照校验、再无条件清空，中间还隔着 siteverify 的网络往返，
  // 两个并发提交都能通过校验并各自推进一次验证。
  const nonce = String(body?.nonce || "");
  const issuedAt = Number(user.nonce_issued_at || 0);
  const nonceOk =
    nonce && user.verify_nonce && timingSafeEqual(nonce, user.verify_nonce) && Date.now() - issuedAt <= NONCE_TTL_MS;
  if (!nonceOk) return json({ ok: false, error: "nonce invalid or expired" }, 403);

  if (!(await siteverify(c, mode, body?.token))) return json({ ok: false, error: "captcha failed" }, 403);

  // 条件消费：WHERE 带上本次使用的 nonce，只有一个并发请求能影响到行
  const consumed = await dbRun(
    c,
    `UPDATE users SET verify_nonce = NULL, nonce_issued_at = NULL, name = ?, username = ?, updated_at = ?
      WHERE user_id = ? AND verify_nonce = ?`,
    [displayName(identity.user), identity.user?.username || null, Date.now(), uid, nonce]
  );
  // 没消费到说明已被并发请求用掉：不重复推进验证，但对调用方仍是成功语义
  if (!consumed) return json({ ok: true });

  // siteverify 已通过，本次请求确实完成了人机验证
  await advanceVerification(c, user, true);
  return json({ ok: true });
}

// ============================================================
// §10 私聊处理
// ============================================================

/**
 * 准入管线第一段：屏蔽 → 限流 → 资料记录 → 验证状态。
 * 新消息与编辑消息共用，避免"新增一条准入策略只改了一处"的结构性隐患。
 * 返回 "blocked" | "rate_limited" | "unverified" | "ok"；
 * 未通过时用户可见提示已就地发出，"unverified" 的后续动作由调用方决定
 * （新消息要走问答/欢迎语，编辑消息只给验证引导）。
 */
async function admitInbound(c, user, msg) {
  const uid = user.user_id;

  // 屏蔽优先于一切：/start 也不解封（旧版曾在此处自愈解封，屏蔽形同虚设）
  if (user.is_blocked) {
    if (await shouldNotify(c, `blocked:${uid}`)) {
      await sendText(c, uid, "🚫 您已被管理员屏蔽，无法发送消息。");
    }
    return "blocked";
  }

  if (await rateLimited(c, uid)) {
    if (await shouldNotify(c, `rlnotice:${uid}`)) {
      await sendText(c, uid, "⏳ 消息发送过于频繁，请稍后再试。");
    }
    return "rate_limited";
  }

  // 记录资料用于资料卡展示
  await updUser(c, uid, { name: displayName(msg.from), username: msg.from?.username || null });

  if (user.state !== "verified") return "unverified";
  return "ok";
}

/**
 * 准入管线第二段：屏蔽关键词 → 消息类型过滤。返回 true 表示可以放行。
 * 与第一段分开，是因为 `/start` 在验证通过后直接回执，不应经过关键词匹配——
 * 合并成单个函数会让 `/start` 被屏蔽词规则命中，属于无关的行为改动。
 */
async function admitContent(c, user, msg) {
  const uid = user.user_id;
  const text = msg.text || msg.caption || "";
  const foldedText = text.toLowerCase();

  // A. 屏蔽词：拦截 + 计数，达阈值自动封禁
  if (text) {
    const keywords = await cfgJson(c, "block_keywords", []);
    if (matchAny(keywords, text, foldedText)) {
      const threshold = parseInt(await cfg(c, "block_threshold"), 10) || 5;

      // 单语句原子自增 + 达阈值置位封禁：消除旧版"读-改-写"在并发违规消息下各读旧值、
      // 都写同值导致的计数丢失。SQLite 的 UPDATE 中 SET 右侧引用列用的是旧值，故 CASE 里
      // 也写 strike_count + 1，与左侧赋值后的新值一致。
      // WHERE is_blocked = 0 不改变正常路径（能到这里的用户准入第一段已过滤），
      // 但让"恰好把计数推过阈值的那次"成为唯一返回 is_blocked=1 的请求——并发封禁通知不会重复发。
      const row = await dbFirst(
        c,
        `UPDATE users
           SET strike_count = strike_count + 1,
               is_blocked = CASE WHEN strike_count + 1 >= ? THEN 1 ELSE is_blocked END
         WHERE user_id = ? AND is_blocked = 0
         RETURNING strike_count, is_blocked`,
        [threshold, uid]
      );

      // row 为空表示该用户已在并发路径中被屏蔽：不再重复通知，直接拦截
      if (!row) return false;

      if (row.is_blocked) {
        await sendText(c, uid, "🚫 您已被系统自动封禁。");
        await syncBlacklistCard(c, { ...user, is_blocked: true, strike_count: row.strike_count }, true);
        await refreshProfileCard(c, uid);
        return false;
      }

      await sendText(c, uid, `⚠️ 消息含有违禁词，已被拦截 (${row.strike_count}/${threshold})`);
      return false;
    }
  }

  // B. 消息类型过滤
  const blockedType = await blockedTypeName(c, msg);
  if (blockedType) {
    await sendText(c, uid, `⚠️ 系统当前不接收${blockedType}。`);
    return false;
  }

  return true;
}

async function handlePrivate(c, msg) {
  const uid = String(msg.chat.id);
  const text = msg.text || "";
  const admin = isAdmin(c, uid);

  // 管理员路径：面板、命令、输入态，全程免验证免限流
  if (admin) return handleAdminPrivate(c, msg, uid, text);

  const user = await getUser(c, uid);
  const stage = await admitInbound(c, user, msg);
  if (stage === "blocked" || stage === "rate_limited") return;

  const isStart = text.startsWith("/start");

  if (stage === "unverified") {
    // 问答阶段的非命令输入按答案处理
    if (user.state === "qa_pending" && text && !isStart) {
      const handled = await handleQaAnswer(c, user, text);
      if (handled) return;
    }

    // 欢迎语在验证流程开始前发一次：state === "new" 表示还没下发过任何验证步骤，
    // 因此不发 /start 直接发消息的用户也能看到欢迎语，而后续消息不会重复轰炸。
    if (isStart || user.state === "new") await sendWelcomeOnce(c, user, msg.from);
    return advanceVerification(c, user);
  }

  if (isStart) {
    await sendText(c, uid, "✅ 您已完成验证，直接发送消息即可联系管理员。");
    return;
  }

  return relayToTopic(c, msg, user);
}

/**
 * 发欢迎语，但同一条 update 只发一次。
 *
 * sendWelcome 自身走 tgQuiet 不抛错，可它之后的 advanceVerification 会写 D1 并可能抛，
 * 那会让 processUpdate 返回 500、Telegram 重投同一 update_id，整段逻辑从头重放，
 * 用户于是收到第二条欢迎语。claim 只防并发重复处理，不防重投重放。
 *
 * 用一条条件 UPDATE 先占住"本 update 已发过欢迎语"，影响 0 行即说明是重放，跳过发送。
 * 判重键取 update_id 而非布尔标记：用户真的再发一次 /start 时 update_id 不同，
 * 仍应重新收到欢迎语，这与旧行为一致。
 * 见 processUpdate 的重放约定。
 */
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

/**
 * 发送欢迎语。管理员内容按纯文本语义处理：
 * 全部转义后再用 HTML 方式发送，等价于原文呈现。
 * 不转义会让含 `<` `>` 的普通文案被 Telegram 当成标签而整条发送失败，
 * 管理员看不到任何报错，用户什么也收不到。
 */
async function sendWelcome(c, uid, from) {
  const raw = await cfg(c, "welcome_msg");
  const name = esc(displayName(from));

  // 欢迎语可能是媒体配置 {type, file_id, caption}
  const media = raw.trim().startsWith("{") ? safeParse(raw, null) : null;
  if (media?.type && media?.file_id) {
    const method = { photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation" }[media.type];
    // caption 同样是管理员输入的纯文本，先转义再替换已转义的用户名
    const caption = esc(String(media.caption || "")).replace(/\{name\}/g, name);
    if (method) {
      const sent = await tgQuiet(c, method, {
        chat_id: uid,
        [media.type]: media.file_id,
        caption,
        parse_mode: "HTML"
      });
      if (sent) return;
    }
    // 媒体发送失败：退回纯文字。绝不能落到下面的 raw 分支——
    // 那会把存储的媒体配置 JSON（含 file_id）当作正文发给用户。
    await sendText(c, uid, caption || "👋 欢迎！");
    return;
  }

  await sendText(c, uid, esc(raw).replace(/\{name\}/g, name));
}

/**
 * 用户编辑私聊消息 → 在其话题内提示。
 * 走与新消息相同的准入管线：旧实现只查了话题与屏蔽状态，
 * 于是 /reset 后的用户可以靠"编辑一条旧消息"把内容送进管理群，绕过验证；
 * 把消息改成含屏蔽词的内容同样不受拦截。
 */
async function handleEditedMessage(c, msg) {
  const uid = String(msg.chat.id);
  if (isAdmin(c, uid)) return;

  const user = await getUser(c, uid);
  const stage = await admitInbound(c, user, msg);
  if (stage === "blocked" || stage === "rate_limited") return;

  if (stage === "unverified") {
    // 编辑不触发问答与欢迎语，只推进验证流程给出引导
    return advanceVerification(c, user);
  }

  if (!(await admitContent(c, user, msg))) return;
  if (!user.topic_id) return; // 尚无话题说明原消息未曾送达，无需提示

  const body = msg.text || msg.caption || "[非文本内容]";
  await sendToTopic(c, user, `✏️ <b>用户修改了消息：</b>\n${esc(body)}`);
}

// ============================================================
// §11 消息中继
// ============================================================

async function relayToTopic(c, msg, user) {
  const uid = user.user_id;
  const text = msg.text || msg.caption || "";
  const foldedText = text.toLowerCase();

  // A/B. 屏蔽词与消息类型过滤（与编辑消息路径共用同一管线）
  if (!(await admitContent(c, user, msg))) return;

  // C. 转发到专属话题。
  // 必须排在给用户的自动回复之前：ensureUserTopic / forwardToTopic 会在话题创建冲突、
  // 建话题失败、转发失败时抛 RetryLater，processUpdate 随即返回 500 让 Telegram 重投同一
  // update_id，整个函数从头重放。claim 只防并发重复执行，不防重投重放，
  // 因此排在它之前的每一次外部发送都会被重放一遍。
  const topicId = await ensureUserTopic(c, user, msg.from);
  await forwardToTopic(c, user, topicId, msg);

  // 下面两段都是发给用户的附加提示，此后不再有抛 RetryLater 的调用，故不会被重投重放。
  // D. 自动回复（不影响正常转发）
  if (text) {
    const rules = await cfgJson(c, "auto_replies", []);
    const hit = (Array.isArray(rules) ? rules : []).find(r => r && matchKeyword(r.kw, text, foldedText));
    if (hit) await sendText(c, uid, esc(hit.reply));
  }

  // E. 休息模式提示（冷却期内不重复打扰）
  if (await cfgBool(c, "busy_mode")) {
    const last = Number(user.last_busy_reply_at || 0);
    if (Date.now() - last > BUSY_REPLY_COOLDOWN_MS) {
      await sendText(c, uid, "🌙 " + esc(await cfg(c, "busy_msg")));
      await updUser(c, uid, { last_busy_reply_at: Date.now() });
    }
  }
}

/**
 * 话题创建：一条原子条件 UPDATE 占位，无锁释放协议、无轮询。
 * 没抢到占位的请求抛 RetryLater → HTTP 500 → Telegram 按退避重投，届时话题已就绪。
 * 占位超过 TOPIC_CLAIM_STALE_MS 视为持有者已挂，允许接管，因此不会死锁。
 *
 * 占位带 fencing token：写回映射时校验自己仍是持有者。仅靠时间戳无法防住
 * "占位过期被接管后原持有者才返回"——那会用孤儿话题覆盖接管者已写入的映射。
 * 见 processUpdate 的重放约定（不可逆副作用须自保重放幂等）。
 */
async function ensureUserTopic(c, user, from) {
  if (user.topic_id) return user.topic_id;

  const uid = user.user_id;
  const now = Date.now();
  const token = genNonce(16);

  const claimed = await dbRun(
    c,
    `UPDATE users SET topic_claim_ts = ?, topic_claim_token = ?, updated_at = ?
     WHERE user_id = ? AND topic_id IS NULL
       AND (topic_claim_ts IS NULL OR topic_claim_ts < ?)`,
    [now, token, now, uid, now - TOPIC_CLAIM_STALE_MS]
  );

  if (!claimed) {
    // 没抢到：可能是并发的另一条消息正在建，也可能刚建完
    const fresh = await getUser(c, uid);
    if (fresh.topic_id) {
      user.topic_id = fresh.topic_id;
      return fresh.topic_id;
    }
    throw new RetryLater("topic is being created");
  }

  let topic;
  try {
    topic = await tg(c, "createForumTopic", {
      chat_id: c.env.ADMIN_GROUP_ID,
      name: topicName(user, from)
    });
  } catch (e) {
    // 清占位让重投可以立即重试；条件带 token，避免清掉接管者的占位
    await dbRun(
      c,
      "UPDATE users SET topic_claim_ts = NULL, topic_claim_token = NULL WHERE user_id = ? AND topic_claim_token = ?",
      [uid, token]
    );
    console.error("createForumTopic failed:", e?.message || e);
    throw new RetryLater("createForumTopic failed");
  }

  const topicId = Number(topic.message_thread_id);
  const written = await dbRun(
    c,
    `UPDATE users SET topic_id = ?, topic_claim_ts = NULL, topic_claim_token = NULL, updated_at = ?
     WHERE user_id = ? AND topic_claim_token = ? AND topic_id IS NULL`,
    [topicId, Date.now(), uid, token]
  );

  if (!written) {
    // 占位已被接管：刚建的话题是孤儿，尽量删掉；删不掉只是留下一个空话题，
    // 属于可见的运维问题，不能因此覆盖当前生效的映射。
    await tgQuiet(c, "deleteForumTopic", {
      chat_id: c.env.ADMIN_GROUP_ID,
      message_thread_id: topicId
    });
    const fresh = await getUser(c, uid);
    if (fresh.topic_id) {
      user.topic_id = fresh.topic_id;
      return fresh.topic_id;
    }
    throw new RetryLater("topic claim taken over");
  }

  user.topic_id = topicId;

  await sendProfileCard(c, { ...user, topic_id: topicId }, from);
  return topicId;
}

function topicName(user, from) {
  const name = displayName(from) || user.name || "用户";
  return `${name} | ${user.user_id}`.slice(0, 128);
}

/**
 * 转发用户消息到话题：forwardMessage 失败降级 copyMessage（用户隐藏转发来源时需要）。
 * 话题异常按三类处理，见 handleTopicError。
 *
 * "retry"/"gone" 都必须抛 RetryLater：前者话题已重开，后者映射已清空、
 * 重投时 ensureUserTopic 会新建话题。若在此静默返回，这条消息既不送达管理员、
 * 用户也收不到任何提示，而入口会返回 200 让 Telegram 不再重投——消息永久丢失。
 */
async function forwardToTopic(c, user, topicId, msg) {
  const payload = {
    chat_id: c.env.ADMIN_GROUP_ID,
    message_thread_id: topicId,
    from_chat_id: user.user_id,
    message_id: msg.message_id
  };

  let ok = false;
  try {
    await tg(c, "forwardMessage", payload);
    ok = true;
  } catch (e) {
    const recovered = await handleTopicError(c, user, e, "user");
    if (recovered !== "ok") throw new RetryLater(`topic ${recovered}, retry relay`);

    try {
      await tg(c, "copyMessage", payload);
      ok = true;
    } catch (e2) {
      const r2 = await handleTopicError(c, user, e2, "user");
      if (r2 !== "ok") throw new RetryLater(`topic ${r2}, retry relay`);
      // 非话题问题的临时故障（限流、网络）：交重投，不静默丢弃
      console.error("Relay failed:", e2?.message || e2);
      throw new RetryLater("relay failed, retry later");
    }
  }

  if (ok) {
    await tgQuiet(c, "setMessageReaction", {
      chat_id: user.user_id,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: DELIVERED_REACTION }]
    });
  }
}

/**
 * 向用户话题发文本（资料卡、编辑提示等）。
 * 与 forwardToTopic 不同，这里失败后不抛 RetryLater：承载的是辅助内容而非用户消息本体，
 * 重投会把已成功转发的原消息一并重放造成重复。失败仅丢一张卡片，由后续操作补偿。
 */
async function sendToTopic(c, user, html, extra = {}) {
  try {
    return await tg(c, "sendMessage", {
      chat_id: c.env.ADMIN_GROUP_ID,
      message_thread_id: user.topic_id,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra
    });
  } catch (e) {
    await handleTopicError(c, user, e, "user");
    return null;
  }
}

/**
 * 话题异常处理，分类见 classifyTgError：
 *   已删除  → 清映射，下条消息自动重建
 *   已关闭  → 自动 reopen；成功则请求重试，失败时按重开错误的分类决定
 *   临时    → 不动映射（避免"报错→清空→重建"循环堆出一串话题）
 * 返回 "retry" 表示已恢复可重试，"gone" 表示映射已清，"ok" 表示非话题问题。
 */
async function handleTopicError(c, user, err, kind) {
  const kindOfErr = classifyTgError(err);

  if (kindOfErr === "topic_closed") {
    // 这里不能用 tgQuiet：它把权限不足（永久）与限流/5xx（临时）都折叠成 null，
    // 于是临时故障会被当成"重开不了"而清空映射，下一条消息又新建话题。
    try {
      await tg(c, "reopenForumTopic", {
        chat_id: c.env.ADMIN_GROUP_ID,
        message_thread_id: kind === "user" ? user.topic_id : user
      });
      return "retry";
    } catch (e2) {
      console.warn("reopenForumTopic failed:", e2?.message || e2);
      // 临时失败保留映射交由重投；仅永久失败才按已删除处理并重建
      if (classifyTgError(e2) === "transient") return "ok";
    }
  } else if (kindOfErr !== "topic_gone") {
    return "ok"; // 限流、网络等临时故障，以及与话题无关的永久错误
  }

  if (kind === "user") {
    // 条件带 topic_id：只清除本次失败所针对的那个话题。
    // 无条件清除会让"针对旧话题的迟到错误"抹掉已经写入的新映射，
    // 使刚建好的话题失联，下条消息又要重建。
    const cleared = await dbRun(
      c,
      "UPDATE users SET topic_id = NULL, topic_claim_ts = NULL, topic_claim_token = NULL, card_msg_id = NULL, updated_at = ? WHERE user_id = ? AND topic_id = ?",
      [Date.now(), String(user.user_id), Number(user.topic_id)]
    );
    if (cleared) user.topic_id = null;
  } else {
    // 同理，只在当前值仍是本次失败的话题时才清空
    await dbRun(c, "UPDATE config SET value = '' WHERE key = 'blacklist_topic_id' AND value = ?", [String(user)]);
    c._cfg = null; // 配置已变更，作废本请求内的 memoize
  }
  return "gone";
}

// ============================================================
// §12 卡片：资料卡 / 黑名单卡
// ============================================================

function profileCardText(user) {
  const joined = user.created_at
    ? new Date(Number(user.created_at)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "-";
  const uname = user.username ? `\n🔗 @${esc(user.username)}` : "";
  const note = user.note ? `\n📝 <b>备注：</b>${esc(user.note)}` : "";
  const status = user.is_blocked ? "\n🚫 <b>状态：</b>已屏蔽" : "";
  return (
    `<b>🪪 用户资料</b>\n` +
    `👤 ${esc(user.name || "用户")}${uname}\n` +
    `🆔 <code>${esc(user.user_id)}</code>${note}${status}\n` +
    `🕒 ${esc(joined)}`
  );
}

const profileCardButtons = user => ({
  inline_keyboard: [
    [{ text: "👤 用户主页", url: `tg://user?id=${user.user_id}` }],
    [
      user.is_blocked
        ? { text: "✅ 解除屏蔽", callback_data: `unblock:${user.user_id}` }
        : { text: "🚫 屏蔽用户", callback_data: `block:${user.user_id}` }
    ],
    [{ text: "✏️ 备注用法", callback_data: `notehelp:${user.user_id}` }]
  ]
});

async function sendProfileCard(c, user, from) {
  const data = { ...user, name: user.name || displayName(from), created_at: user.created_at || Date.now() };
  // 首张卡片就带上与刷新后一致的按钮：旧实现只有 refreshProfileCard 才附按钮，
  // 管理员必须先做一次备注或屏蔽操作触发刷新，屏蔽入口才出现。
  const card = await sendToTopic(c, user, profileCardText(data), { reply_markup: profileCardButtons(data) });
  if (!card) return;

  await updUser(c, user.user_id, { card_msg_id: card.message_id });
  await tgQuiet(c, "pinChatMessage", {
    chat_id: c.env.ADMIN_GROUP_ID,
    message_id: card.message_id,
    disable_notification: true
  });
}

/** 备注变更、屏蔽状态变化后刷新置顶资料卡 */
async function refreshProfileCard(c, uid) {
  const user = await getUser(c, uid);
  if (!user.card_msg_id) return;

  await tgQuiet(c, "editMessageText", {
    chat_id: c.env.ADMIN_GROUP_ID,
    message_id: user.card_msg_id,
    text: profileCardText(user),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: profileCardButtons(user)
  });
}

/**
 * 黑名单共享话题：与用户话题同样的原子占位协议 + fencing token。
 * 没抢到占位时返回空——卡片是辅助路径，屏蔽状态本身已生效，卡片由后续操作补偿。
 * 占位值形如 `<时间戳>:<token>`，释放与写回都校验 token，
 * 避免占位过期被接管后原持有者释放他人的占位或覆盖他人写入的话题号。
 */
async function ensureBlacklistTopic(c) {
  const existing = await cfg(c, "blacklist_topic_id");
  if (existing) return Number(existing);

  const now = Date.now();
  const lockKey = "blacklist_topic_claim";
  const token = genNonce(16);
  const claimValue = `${now}:${token}`;

  // UPDATE 影响 0 行时无法区分"没抢到"和"行不存在"，先确保锁行存在
  await dbRun(c, "INSERT OR IGNORE INTO config (key, value) VALUES (?, '0')", [lockKey]);

  const claimed = await dbRun(
    c,
    `UPDATE config SET value = ?
     WHERE key = ? AND (value = '0' OR CAST(value AS INTEGER) < ?)`,
    [claimValue, lockKey, now - TOPIC_CLAIM_STALE_MS]
  );
  if (!claimed) {
    const retry = await dbFirst(c, "SELECT value FROM config WHERE key = 'blacklist_topic_id'");
    return retry?.value ? Number(retry.value) : 0;
  }

  let id = 0;
  try {
    const topic = await tg(c, "createForumTopic", { chat_id: c.env.ADMIN_GROUP_ID, name: "🚫 黑名单" });
    id = Number(topic.message_thread_id);

    // 先确保行存在，写入才能用单条条件 UPDATE 表达"占位仍是我的"。
    // 若用 INSERT ... ON CONFLICT，WHERE 只作用于冲突分支，行不存在时会绕过占位校验。
    await dbRun(c, "INSERT OR IGNORE INTO config (key, value) VALUES ('blacklist_topic_id', '')");
    const written = await dbRun(
      c,
      `UPDATE config SET value = ?
        WHERE key = 'blacklist_topic_id' AND value = ''
          AND (SELECT value FROM config WHERE key = ?) = ?`,
      [String(id), lockKey, claimValue]
    );
    c._cfg = null; // 配置已变更，作废本请求内的 memoize

    if (!written) {
      // 占位已被接管：删掉孤儿话题，改用当前生效的话题号
      await tgQuiet(c, "deleteForumTopic", { chat_id: c.env.ADMIN_GROUP_ID, message_thread_id: id });
      const cur = await dbFirst(c, "SELECT value FROM config WHERE key = 'blacklist_topic_id'");
      return cur?.value ? Number(cur.value) : 0;
    }
    return id;
  } catch (e) {
    console.error("create blacklist topic failed:", e?.message || e);
    return 0;
  } finally {
    // 只释放自己持有的占位，不动接管者的
    await dbRun(c, "UPDATE config SET value = '0' WHERE key = ? AND value = ?", [lockKey, claimValue]);
  }
}

/** 屏蔽 → 生成黑名单卡片；解封 → 删除卡片 */
async function syncBlacklistCard(c, user, blocking) {
  const uid = user.user_id;

  if (!blocking) {
    if (user.blacklist_msg_id) {
      await tgQuiet(c, "deleteMessage", { chat_id: c.env.ADMIN_GROUP_ID, message_id: user.blacklist_msg_id });
      await updUser(c, uid, { blacklist_msg_id: null });
    }
    return;
  }

  const topicId = await ensureBlacklistTopic(c);
  if (!topicId) return; // 话题未就绪，屏蔽仍然生效，卡片下次补

  const text = `<b>🚫 用户已屏蔽</b>\n${profileCardText({ ...user, is_blocked: true })}`;
  const markup = { inline_keyboard: [[{ text: "✅ 解除屏蔽", callback_data: `unblock:${uid}` }]] };
  // 卡片正文与 markup 在编辑/新建两路共用，差异只在定位字段（message_id vs message_thread_id）
  const base = {
    chat_id: c.env.ADMIN_GROUP_ID,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: markup
  };

  // 已有卡片就原地编辑。无条件新建会覆盖 blacklist_msg_id，旧卡片再无人回收：
  // 解封只删得掉最后一张，先前的永久留在黑名单话题里。
  // 触发不需要任何故障——自动封禁建卡后，管理员点资料卡上那颗尚未刷新的"屏蔽"按钮即可，
  // 而 refreshProfileCard 走 tgQuiet，刷新失败被吞掉时按钮会一直停在"屏蔽用户"。
  if (user.blacklist_msg_id) {
    const edited = await tgQuiet(c, "editMessageText", {
      ...base,
      message_id: user.blacklist_msg_id
    });
    if (edited !== null) return;
    // 编辑失败（卡片被管理员手工删除等）：落到下面新建，避免屏蔽状态在群里没有任何呈现
  }

  try {
    const card = await tg(c, "sendMessage", { ...base, message_thread_id: topicId });
    await updUser(c, uid, { blacklist_msg_id: card.message_id });
  } catch (e) {
    await handleTopicError(c, topicId, e, "shared");
  }
}

// ============================================================
// §13 管理群处理
// ============================================================

async function handleGroupMessage(c, msg) {
  if (msg.from?.is_bot) return;
  if (!isAdmin(c, msg.from?.id)) return;
  if (!msg.message_thread_id) return;

  const user = await getUserByTopic(c, msg.message_thread_id);
  if (!user) return; // 非用户话题（如黑名单话题）内的闲聊

  const text = msg.text || "";

  if (text.startsWith("/note")) {
    const note = text.slice(5).trim();
    await updUser(c, user.user_id, { note: note || null });
    await refreshProfileCard(c, user.user_id);
    await tgQuiet(c, "sendMessage", {
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text: note ? `✅ 备注已更新：${esc(note)}` : "✅ 备注已清除",
      parse_mode: "HTML"
    });
    return;
  }

  // 其余消息一律转达给用户
  try {
    await tg(c, "copyMessage", {
      chat_id: user.user_id,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  } catch (e) {
    // 临时故障（限流、5xx、网络）交给重投：旧实现一律提示后返回 200，
    // 管理员看到"发送失败"却无从得知只是网络抖动，回复实际被丢弃。
    // claim 机制保证同一 update 的重投不会重复送达。
    if (classifyTgError(e) === "transient") {
      console.warn("admin reply transient failure:", e?.message || e);
      throw new RetryLater("admin reply failed, retry later");
    }
    // 永久失败（用户停用机器人等）：重投也不会成功，就地提示管理员
    await tgQuiet(c, "sendMessage", {
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text: `❌ 发送失败：${esc(e?.message || "用户可能已停用机器人")}`,
      parse_mode: "HTML"
    });
  }
}

// ============================================================
// §14 回调处理
// ============================================================

async function handleCallback(c, cb) {
  const data = String(cb.data || "");
  const [action, ...rest] = data.split(":");
  const answer = (text, alert = false) =>
    tgQuiet(c, "answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert });

  if (!isAdmin(c, cb.from?.id)) return answer("无权限", true);

  if (action === "block" || action === "unblock") {
    const uid = rest[0];
    const blocking = action === "block";
    await updUser(c, uid, { is_blocked: blocking, strike_count: 0 });

    const user = await getUser(c, uid);
    await syncBlacklistCard(c, user, blocking);
    await refreshProfileCard(c, uid);

    if (blocking) await sendText(c, uid, "🚫 您已被管理员屏蔽。");
    else await sendText(c, uid, "✅ 您已被解除屏蔽，可以继续发送消息。");

    return answer(blocking ? "已屏蔽" : "已解除屏蔽");
  }

  if (action === "notehelp") {
    await answer();
    return tgQuiet(c, "sendMessage", {
      chat_id: cb.message.chat.id,
      message_thread_id: cb.message.message_thread_id,
      text: "⌨️ 在本话题内发送：\n<code>/note 备注内容</code> 设置备注\n<code>/note</code> 清除备注",
      parse_mode: "HTML"
    });
  }

  if (action === "panel") {
    await answer();
    return handlePanelCallback(c, cb, rest);
  }
}

// ============================================================
// §15 管理员私聊：命令与输入态
// ============================================================

async function handleAdminPrivate(c, msg, uid, text) {
  // 输入态优先：面板点了"编辑/添加"后，下一条消息就是新值
  const stateRaw = await cfg(c, `admin_state:${uid}`);
  if (stateRaw) {
    const state = safeParse(stateRaw, null);
    if (state?.field) return handleAdminInput(c, uid, msg, state);
  }

  if (text.startsWith("/start")) {
    await registerCommands(c);
    return renderPanel(c, uid, null, "home");
  }

  if (text.startsWith("/reset")) {
    const target = text.trim().split(/\s+/)[1] || "";
    if (!/^\d+$/.test(target)) {
      return sendText(c, uid, "用法：<code>/reset 用户ID</code>\n例如：<code>/reset 123456789</code>");
    }
    await resetUserVerification(c, target);
    await sendText(c, target, "⚠️ 管理员已要求您重新验证，请发送 /start 重新开始。");
    return sendText(c, uid, `✅ 已重置用户 <code>${esc(target)}</code> 的验证状态。`);
  }

  if (text.startsWith("/help")) {
    return sendText(
      c,
      uid,
      "ℹ️ <b>管理员帮助</b>\n" +
        "• /start 打开控制面板\n" +
        "• /reset &lt;用户ID&gt; 重置用户验证\n" +
        "• 在用户话题内回复即可对话\n" +
        "• 在用户话题内 /note 内容 设置备注"
    );
  }
}

/** 消化面板的输入态：写入配置后清除状态并回到对应面板页 */
async function handleAdminInput(c, uid, msg, state) {
  const text = msg.text || "";
  const back = INPUT_SPECS[state.field]?.back || "home";

  if (text.trim() === "/cancel") {
    await delCfg(c, `admin_state:${uid}`);
    await sendText(c, uid, "已取消。");
    return renderPanel(c, uid, null, back);
  }

  try {
    await applyAdminInput(c, state, msg, text);
  } catch (e) {
    return sendText(c, uid, `❌ ${esc(e.message)}`);
  }

  await delCfg(c, `admin_state:${uid}`);
  await sendText(c, uid, "✅ 已保存。");
  return renderPanel(c, uid, null, back);
}

async function applyAdminInput(c, state, msg, text) {
  switch (state.field) {
    case "welcome_msg": {
      // 欢迎语可以是媒体：存 {type, file_id, caption}
      const media = msg.photo
        ? { type: "photo", file_id: msg.photo[msg.photo.length - 1].file_id }
        : msg.video
          ? { type: "video", file_id: msg.video.file_id }
          : msg.animation
            ? { type: "animation", file_id: msg.animation.file_id }
            : null;

      if (media) {
        return setCfg(c, "welcome_msg", JSON.stringify({ ...media, caption: msg.caption || "" }));
      }
      if (!text.trim()) throw new Error("内容不能为空");
      return setCfg(c, "welcome_msg", text);
    }

    case "busy_msg":
      if (!text.trim()) throw new Error("内容不能为空");
      return setCfg(c, "busy_msg", text);

    case "block_threshold": {
      const n = parseInt(text.trim(), 10);
      if (!Number.isFinite(n) || n < 1) throw new Error("请输入大于 0 的整数");
      return setCfg(c, "block_threshold", String(n));
    }

    case "qa_add": {
      const idx = text.indexOf("===");
      if (idx < 0) throw new Error("格式错误，请使用：问题===答案");
      const q = text.slice(0, idx).trim();
      const a = text.slice(idx + 3).trim();
      if (!q || !a) throw new Error("问题与答案都不能为空");
      // CAS 追加：直接读-改-写会让并发添加的后写者用旧快照覆盖对方的新条目。
      // id 取自本次 update，重投时重算得同一个值，据此判重可避免重复追加，
      // 同时同毫秒的并发添加也不会撞号（纯时间戳会）。
      // 幂等键绑 update_id——见 processUpdate 的重放约定。
      const ok = await updateCfgListCas(c, "qa_questions", list =>
        appendOnce(list, { id: entryId(c), q, a })
      );
      if (!ok) throw new Error("保存失败，请重试");
      return;
    }

    case "kw_add": {
      const kw = text.trim();
      if (!kw) throw new Error("关键词不能为空");
      // 屏蔽词是裸字符串，没有 id 可承载幂等键。同值条目本就等价，
      // 重复追加既无功能意义又会让面板出现两行相同项，故按值判重。
      const ok = await updateCfgListCas(c, "block_keywords", list =>
        list.some(x => kwKey(x) === kwKey(kw)) ? undefined : [...list, kw]
      );
      if (!ok) throw new Error("保存失败，请重试");
      return;
    }

    case "ar_add": {
      const idx = text.indexOf("===");
      if (idx < 0) throw new Error("格式错误，请使用：关键词===回复内容");
      const kw = text.slice(0, idx).trim();
      const reply = text.slice(idx + 3).trim();
      if (!kw || !reply) throw new Error("关键词与回复内容都不能为空");
      // 与 qa_add 同：id 绑 update_id 做重放判重——见 processUpdate 的重放约定。
      const ok = await updateCfgListCas(c, "auto_replies", list =>
        appendOnce(list, { id: entryId(c), kw, reply })
      );
      if (!ok) throw new Error("保存失败，请重试");
      return;
    }

    default:
      throw new Error("未知的输入类型");
  }
}

/**
 * 列表条目 id：绑定当前 update 而非时间戳。
 * update_id 由 Telegram 保证唯一，且重投同一条消息时不变——
 * 处理链在写入列表之后、清除输入态之前失败会触发重投并重放整个流程，
 * 用它作 id 才能在重放时被 appendOnce 识别为同一条而不是新条目。
 * 见 processUpdate 的重放约定。
 */
function entryId(c) {
  return `u${c.updateId}`;
}

/** 按 id 幂等追加：已存在同 id 则原样返回。
 *  不能返回 undefined —— 那在 updateCfgCas 里表示"放弃写入"并返回 false，
 *  会被调用方的 `if (!ok) throw` 当成保存失败，让已经写入的条目反而报错给管理员。
 *  原样写回同一份列表则是成功语义，重放时行为与首次一致。 */
function appendOnce(list, entry) {
  return list.some(x => x && String(x.id) === entry.id) ? list : [...list, entry];
}

async function registerCommands(c) {
  await tgQuiet(c, "setMyCommands", {
    commands: [{ command: "start", description: "开始" }],
    scope: { type: "default" }
  });
  for (const id of getAdminSet(c)) {
    await tgQuiet(c, "setMyCommands", {
      commands: [
        { command: "start", description: "控制面板" },
        { command: "help", description: "帮助" },
        { command: "reset", description: "重置用户验证" }
      ],
      scope: { type: "chat", chat_id: id }
    });
  }
}

// ============================================================
// §16 管理面板
// ============================================================

const BACK_HOME = { text: "🔙 返回", callback_data: "panel:home" };

/** 面板值回显：转义防解析失败（含 < 的值会让 sendMessage 400，整个面板静默失灵）+ 截断 */
function preview(raw, max = 200) {
  let s = String(raw ?? "");
  if (!s.trim()) return "<i>(未设置)</i>";

  if (s.trim().startsWith("{")) {
    const m = safeParse(s, null);
    if (m?.type) {
      const label = { photo: "图片", video: "视频", animation: "GIF" }[m.type] || m.type;
      s = `[${label}]${m.caption ? " " + m.caption : ""}`;
    }
  }
  return esc(s.length > max ? s.slice(0, max) + "…" : s);
}

async function handlePanelCallback(c, cb, parts) {
  const uid = String(cb.from.id);
  const mid = cb.message?.message_id || null;
  const [page, arg1, arg2] = parts;

  // 开关切换：基于当前持久化值原子完成。
  // 读一次再无条件写会让并发切换的后写者覆盖前者，两个开关只生效一个。
  if (page === "toggle") {
    const ok = await updateCfgCas(c, arg1, cur => (String(cur) === "true" ? "false" : "true"));
    return renderPanel(c, uid, mid, arg2 || "home", ok ? "" : "⚠️ 操作未生效，请重试。");
  }

  // 验证码模式三态轮换：Cloudflare → Google → 关闭 → Cloudflare
  if (page === "captcha_rotate") {
    const on = await cfgBool(c, "enable_captcha");
    const mode = await cfg(c, "captcha_mode");
    if (!on) {
      await setCfg(c, "enable_captcha", "true");
      await setCfg(c, "captcha_mode", "turnstile");
    } else if (mode === "turnstile") {
      await setCfg(c, "captcha_mode", "recaptcha");
    } else {
      await setCfg(c, "enable_captcha", "false");
    }
    return renderPanel(c, uid, mid, "verify");
  }

  // 列表删除：全部走 CAS，冲突时重读重放；目标条目已不在则视为他人已删，
  // 明确提示未生效，而不是静默成功或误删位置相同的另一条
  if (page === "del") {
    if (arg1 === "qa") {
      const ok = await updateCfgListCas(c, "qa_questions", list => {
        const next = list.filter(q => String(q.id) !== String(arg2));
        return next.length === list.length ? undefined : next;
      });
      return renderPanel(c, uid, mid, "qa", ok ? "" : "⚠️ 该题目已不存在，操作未生效。");
    }
    if (arg1 === "kw") {
      const ok = await updateCfgListCas(c, "block_keywords", list => {
        const idx = list.findIndex(kw => kwKey(kw) === String(arg2));
        if (idx < 0) return undefined; // 已被他人删除
        const next = list.slice();
        next.splice(idx, 1);
        return next;
      });
      return renderPanel(c, uid, mid, "kw", ok ? "" : "⚠️ 该屏蔽词已不存在，操作未生效。");
    }
    if (arg1 === "ar") {
      const ok = await updateCfgListCas(c, "auto_replies", list => {
        const next = list.filter(r => String(r.id) !== String(arg2));
        return next.length === list.length ? undefined : next;
      });
      return renderPanel(c, uid, mid, "ar", ok ? "" : "⚠️ 该规则已不存在，操作未生效。");
    }
  }

  // 进入输入态
  if (page === "input") {
    const spec = INPUT_SPECS[arg1];
    if (!spec) return;
    await setCfg(c, `admin_state:${uid}`, JSON.stringify({ field: arg1 }));

    let prompt = spec.prompt;
    if (spec.showCurrent) prompt += `\n\n<b>当前值：</b>\n${preview(await cfg(c, spec.showCurrent))}`;
    return tgQuiet(c, "editMessageText", {
      chat_id: uid,
      message_id: mid,
      text: prompt + "\n\n发送 /cancel 取消。",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    });
  }

  if (page === "reset_blacklist") {
    await setCfg(c, "blacklist_topic_id", "");
    return renderPanel(c, uid, mid, "maint");
  }

  return renderPanel(c, uid, mid, page || "home");
}

const INPUT_SPECS = {
  welcome_msg: {
    back: "welcome",
    showCurrent: "welcome_msg",
    prompt: "请发送新的欢迎语。\n• 支持纯文本或图片/视频/GIF\n• 可用占位符 <code>{name}</code>"
  },
  busy_msg: { back: "busy", showCurrent: "busy_msg", prompt: "请发送新的忙碌回复语。" },
  block_threshold: {
    back: "kw",
    showCurrent: "block_threshold",
    prompt: "请输入自动封禁阈值（违规几次后封禁）。"
  },
  qa_add: {
    back: "qa",
    prompt: "请添加验证题目，格式：\n<code>问题===答案</code>\n\n例如：\n<code>1+1=?===2</code>\n\n每次添加一条。"
  },
  kw_add: {
    back: "kw",
    prompt:
      "请输入要屏蔽的关键词。\n\n" +
      "• 默认子串匹配，不区分大小写\n" +
      "• 需要正则时加 <code>re:</code> 前缀，如 <code>re:加微信\\d+</code>\n\n每次添加一条。"
  },
  ar_add: {
    back: "ar",
    prompt:
      "请添加自动回复规则，格式：\n<code>关键词===回复内容</code>\n\n" +
      "例如：\n<code>价格===请联系人工客服</code>\n\n关键词同样支持 <code>re:</code> 前缀。"
  }
};

/** mid 为空时发新消息，否则原地编辑（面板不堆积） */
/**
 * 渲染面板页。notice 用于承载"操作未生效"这类一次性反馈：
 * handleCallback 早已 answer 过回调，无法再弹窗，只能显示在面板正文里。
 */
async function renderPanel(c, uid, mid, page, notice = "") {
  const view = await buildPanelPage(c, page);
  const payload = {
    chat_id: uid,
    text: notice ? `${notice}\n\n${view.text}` : view.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: view.keyboard }
  };

  if (mid) {
    const r = await tgQuiet(c, "editMessageText", { ...payload, message_id: mid });
    if (r !== null) return r;
    // 编辑失败（内容未变等）时退化为发新消息，避免面板无响应
  }
  return tgQuiet(c, "sendMessage", payload);
}

async function buildPanelPage(c, page) {
  switch (page) {
    case "verify":
      return panelVerify(c);
    case "qa":
      return panelQaBank(c);
    case "welcome":
      return panelWelcome(c);
    case "kw":
      return panelKeywords(c);
    case "ar":
      return panelAutoReplies(c);
    case "filter":
      return panelFilter(c);
    case "busy":
      return panelBusy(c);
    case "maint":
      return panelMaint(c);
    default:
      return panelHome(c);
  }
}

async function panelHome(c) {
  const captcha = await captchaLabel(c);
  const qaOn = await cfgBool(c, "enable_qa");
  const busy = await cfgBool(c, "busy_mode");

  return {
    text:
      "⚙️ <b>控制面板</b>\n\n" +
      `🛡️ 人机验证：${captcha}\n` +
      `❓ 问答验证：${qaOn ? "✅ 开启" : "❌ 关闭"}\n` +
      `🌙 营业状态：${busy ? "🔴 休息中" : "🟢 营业中"}`,
    keyboard: [
      [
        { text: "🛡️ 验证设置", callback_data: "panel:verify" },
        { text: "💬 欢迎语", callback_data: "panel:welcome" }
      ],
      [
        { text: "🚫 屏蔽词", callback_data: "panel:kw" },
        { text: "🤖 自动回复", callback_data: "panel:ar" }
      ],
      [
        { text: "🛠 转发设置", callback_data: "panel:filter" },
        { text: "🌙 营业状态", callback_data: "panel:busy" }
      ],
      [{ text: "🔧 维护", callback_data: "panel:maint" }]
    ]
  };
}

async function captchaLabel(c) {
  if (!(await cfgBool(c, "enable_captcha"))) return "❌ 已关闭";
  return (await cfg(c, "captcha_mode")) === "recaptcha" ? "Google reCAPTCHA" : "Cloudflare Turnstile";
}

async function panelVerify(c) {
  const captcha = await captchaLabel(c);
  const qaOn = await cfgBool(c, "enable_qa");
  const bank = await cfgJson(c, "qa_questions", []);
  const emptyWarn = qaOn && !bank.length ? "\n\n⚠️ <b>题库为空，问答验证当前不生效。</b>" : "";

  return {
    text:
      "🛡️ <b>验证设置</b>\n\n" +
      `人机验证：${captcha}\n` +
      `问答验证：${qaOn ? "✅ 开启" : "❌ 关闭"}（题库 ${bank.length} 题）${emptyWarn}`,
    keyboard: [
      [{ text: `人机验证：${captcha}（点击切换）`, callback_data: "panel:captcha_rotate" }],
      [{ text: `问答验证：${qaOn ? "✅ 开启" : "❌ 关闭"}`, callback_data: "panel:toggle:enable_qa:verify" }],
      [{ text: `❓ 问答题库（${bank.length}）`, callback_data: "panel:qa" }],
      [BACK_HOME]
    ]
  };
}

async function panelQaBank(c) {
  const bank = await cfgJson(c, "qa_questions", []);
  const rows = bank.map(q => [
    { text: `🗑 ${String(q.q).slice(0, 40)} → ${String(q.a).slice(0, 12)}`, callback_data: `panel:del:qa:${q.id}` }
  ]);
  rows.push([{ text: "➕ 添加题目", callback_data: "panel:input:qa_add" }], [
    { text: "🔙 返回", callback_data: "panel:verify" }
  ]);

  return {
    text:
      "❓ <b>问答题库</b>\n" +
      "用户验证时从题库随机抽一题，答错自动换题。\n\n" +
      (bank.length ? `共 ${bank.length} 题，点击可删除：` : "题库为空，问答验证不会生效。"),
    keyboard: rows
  };
}

async function panelWelcome(c) {
  return {
    text:
      `💬 <b>欢迎语</b>\n新用户首次触达时发送，内容按纯文本原样呈现。\n\n` +
      `<b>当前内容：</b>\n${preview(await cfg(c, "welcome_msg"))}`,
    keyboard: [[{ text: "✏️ 修改欢迎语", callback_data: "panel:input:welcome_msg" }], [BACK_HOME]]
  };
}

/** 条目在面板中的显示前缀：不生效的 `re:` 规则要显式标出，否则管理员会以为仍在防护 */
function entryMark(kw) {
  const s = String(kw ?? "").trim();
  if (!s.startsWith("re:")) return "";
  return isValidRePattern(s.slice(3).trim()) ? "" : "⚠️未生效 ";
}

/**
 * 屏蔽词的删除键：内容哈希，而不是列表索引。
 * 索引在他人删除后会整体前移，管理员点击自己那张旧面板上的按钮就会删错条目。
 * 用内容派生的短键则天然指向"当时看到的那个词"，条目不在了就是不在了。
 * callback_data 上限 64 字节，关键词可能很长，故取哈希而非原文。
 */
function kwKey(kw) {
  const s = String(kw ?? "");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + ch, 0x85ebca6b) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

async function panelKeywords(c) {
  const list = await cfgJson(c, "block_keywords", []);
  const threshold = await cfg(c, "block_threshold");
  // 用内容哈希作删除键：索引会因他人删除而前移，导致点旧按钮删错条目
  const rows = list.map(kw => [
    { text: `🗑 ${entryMark(kw)}${String(kw).slice(0, 50)}`, callback_data: `panel:del:kw:${kwKey(kw)}` }
  ]);
  rows.push(
    [{ text: "➕ 添加屏蔽词", callback_data: "panel:input:kw_add" }],
    [{ text: `⚙️ 封禁阈值：${threshold} 次`, callback_data: "panel:input:block_threshold" }],
    [BACK_HOME]
  );

  const invalid = list.filter(kw => entryMark(kw)).length;
  return {
    text:
      "🚫 <b>屏蔽词</b>\n" +
      `命中后消息不转发并计违规，累计 ${esc(threshold)} 次自动封禁。\n\n` +
      (list.length ? `共 ${list.length} 条，点击可删除：` : "暂无屏蔽词。") +
      (invalid ? `\n\n⚠️ 有 ${invalid} 条 <code>re:</code> 规则不在安全子集内，当前不生效。` : ""),
    keyboard: rows
  };
}

async function panelAutoReplies(c) {
  const list = await cfgJson(c, "auto_replies", []);
  const rows = list.map(r => [
    {
      text: `🗑 ${entryMark(r.kw)}${String(r.kw).slice(0, 30)} → ${String(r.reply).slice(0, 20)}`,
      callback_data: `panel:del:ar:${r.id}`
    }
  ]);
  rows.push([{ text: "➕ 添加规则", callback_data: "panel:input:ar_add" }], [BACK_HOME]);

  const invalid = list.filter(r => entryMark(r?.kw)).length;
  return {
    text:
      "🤖 <b>自动回复</b>\n" +
      "命中关键词时自动回复用户，消息仍正常转发。\n\n" +
      (list.length ? `共 ${list.length} 条，点击可删除：` : "暂无规则。") +
      (invalid ? `\n\n⚠️ 有 ${invalid} 条 <code>re:</code> 规则不在安全子集内，当前不生效。` : ""),
    keyboard: rows
  };
}

const FILTER_ITEMS = [
  ["allow_forward", "转发"],
  ["allow_media", "媒体"],
  ["allow_audio", "语音"],
  ["allow_sticker", "贴纸"],
  ["allow_link", "链接"],
  ["allow_channel", "频道"],
  ["allow_text", "文本"]
];

async function panelFilter(c) {
  const rows = [];
  for (let i = 0; i < FILTER_ITEMS.length; i += 2) {
    const row = [];
    for (const [key, label] of FILTER_ITEMS.slice(i, i + 2)) {
      const on = await cfgBool(c, key);
      // 按钮兼作状态显示：只放符号会让"点了是开还是关"产生歧义
      row.push({ text: `${label} ${on ? "✅ 接收" : "❌ 拦截"}`, callback_data: `panel:toggle:${key}:filter` });
    }
    rows.push(row);
  }
  rows.push([BACK_HOME]);

  return { text: "🛠 <b>转发设置</b>\n点击切换该类型消息是否接收。", keyboard: rows };
}

async function panelBusy(c) {
  const on = await cfgBool(c, "busy_mode");
  return {
    text:
      `🌙 <b>营业状态</b>\n当前：${on ? "🔴 休息中" : "🟢 营业中"}\n\n` +
      `<b>忙碌回复语：</b>\n${preview(await cfg(c, "busy_msg"))}`,
    keyboard: [
      [{ text: `切换为 ${on ? "🟢 营业中" : "🔴 休息中"}`, callback_data: "panel:toggle:busy_mode:busy" }],
      [{ text: "✏️ 修改回复语", callback_data: "panel:input:busy_msg" }],
      [BACK_HOME]
    ]
  };
}

async function panelMaint(c) {
  const tid = await cfg(c, "blacklist_topic_id");
  return {
    text:
      "🔧 <b>维护</b>\n\n" +
      `黑名单话题：${tid ? `✅ 已创建 (${esc(tid)})` : "⏳ 尚未创建"}\n\n` +
      "误删或误关话题后可点击重置，系统会在下次需要时自动新建。",
    keyboard: [[{ text: "♻️ 重置黑名单话题", callback_data: "panel:reset_blacklist" }], [BACK_HOME]]
  };
}




