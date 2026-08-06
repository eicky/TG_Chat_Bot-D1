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

// Telegram API 重试
const TG_MAX_RETRIES = 3;
const TG_BACKOFF_MS = [200, 500, 1200];
const TG_TOTAL_WAIT_CAP_MS = 10_000;

// 正则安全（ReDoS 缓解）
const RE_MAX_PATTERN_LEN = 256;
const RE_MAX_TEXT_LEN = 512;
// 嵌套量词、反向引用、变长后行断言都可能引发灾难性回溯，直接拒绝执行
const RE_REJECT = [/\([^)]*\)\s*[+*{]/, /\(\s*\.[*+]\s*\)\s*[+*]/, /\\[1-9]/, /\(\?<[=!]/];

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
 * 去重标记在处理成功后才写入，因此 500 路径天然允许重试。
 */
async function processUpdate(update, env) {
  const updateId = update?.update_id;
  if (updateId === undefined || updateId === null) return new Response("OK");

  const c = newCtx(env);
  await ensureSchema(env);

  if (await isUpdateProcessed(c, updateId)) return new Response("OK");

  try {
    await dispatch(c, update);
  } catch (e) {
    if (e instanceof RetryLater) {
      // 不写去重标记：Telegram 会重投，届时前置条件（如话题）通常已就绪
      return new Response("Retry later", { status: 500 });
    }
    console.error("Dispatch failed:", e?.stack || e?.message || e);
    // 未知异常同样交给重投，避免消息静默丢失
    return new Response("Error", { status: 500 });
  }

  await markUpdateProcessed(c, updateId);
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
}

/**
 * 每个请求一个上下文：配置在请求内 memoize，请求间不缓存。
 * 旧版的跨请求 isolate 缓存会让面板显示别的 isolate 的过期状态，这里从根上避免。
 */
function newCtx(env) {
  return { env, _cfg: null, _admins: null };
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
  await dbRun(c, "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
    key,
    String(value)
  ]);
  if (c._cfg) c._cfg[key] = String(value);
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
  "last_busy_reply_at"
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

// --- update 幂等 ---

async function isUpdateProcessed(c, updateId) {
  const row = await dbFirst(c, "SELECT 1 AS x FROM processed_updates WHERE update_id = ?", [String(updateId)]);
  return !!row;
}

async function markUpdateProcessed(c, updateId) {
  try {
    await dbRun(c, "INSERT OR IGNORE INTO processed_updates (update_id, ts) VALUES (?, ?)", [
      String(updateId),
      Date.now()
    ]);
  } catch {
    // 去重标记写失败最多导致一次重复处理，不值得让整条消息失败
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

      if (code === 429) {
        const ra = Number(d?.parameters?.retry_after || 0);
        delay = Math.min(5000, Math.max(200, ra ? ra * 1000 : delay));
        retryable = true;
      } else if (code >= 500) {
        retryable = true;
      }
    } catch (e) {
      lastErr = e;
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

async function getAdminSet(c) {
  if (c._admins) return c._admins;
  c._admins = new Set(
    String(c.env.ADMIN_IDS || "")
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean)
  );
  return c._admins;
}

async function isAdmin(c, userId) {
  return (await getAdminSet(c)).has(String(userId));
}

// ============================================================
// §7 过滤引擎：关键词匹配 + 消息类型判定
// ============================================================

/**
 * 关键词匹配：默认小写子串；`re:` 前缀走正则。
 * 旧版把所有条目都当正则执行，普通词也白白承担 ReDoS 面，这里只有显式声明才进正则分支。
 */
function matchKeyword(pattern, text) {
  const p = String(pattern ?? "").trim();
  const t = String(text ?? "");
  if (!p || !t) return false;

  if (!p.startsWith("re:")) return t.toLowerCase().includes(p.toLowerCase());

  const src = p.slice(3).trim();
  if (!src || src.length > RE_MAX_PATTERN_LEN) return false;
  for (const bad of RE_REJECT) if (bad.test(src)) return false;

  try {
    // 截断被检文本：即使模式漏过形态检查，回溯规模也有上界
    return new RegExp(src, "i").test(t.slice(0, RE_MAX_TEXT_LEN));
  } catch {
    return false; // 非法正则视为不匹配，不影响其余条目
  }
}

function matchAny(patterns, text) {
  return (Array.isArray(patterns) ? patterns : []).some(p => matchKeyword(p, text));
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

async function qaEnabled(c) {
  if (!(await cfgBool(c, "enable_qa"))) return false;
  const bank = await cfgJson(c, "qa_questions", []);
  return Array.isArray(bank) && bank.length > 0; // 题库为空等效关闭，否则用户会被堵死在无题可答的状态
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
 */
async function advanceVerification(c, user, tgUser) {
  const uid = user.user_id;
  const mode = await captchaMode(c);

  if (user.state === "new" && mode) return sendCaptchaStep(c, uid, mode);
  if (user.state === "new" || user.state === "captcha_pending") {
    if (await qaEnabled(c)) return sendQaQuestion(c, uid, false);
    return markVerified(c, uid);
  }
  if (user.state === "qa_pending") return sendQaQuestion(c, uid, false);
  return markVerified(c, uid);
}

async function sendCaptchaStep(c, uid, mode) {
  const base = String(c.env.WORKER_URL || "").replace(/\/+$/, "");
  if (!base) {
    // 没配 WORKER_URL 就无法承载验证页，跳过人机验证而不是把用户堵死
    console.error("WORKER_URL is not configured; skipping captcha");
    if (await qaEnabled(c)) return sendQaQuestion(c, uid, false);
    return markVerified(c, uid);
  }

  const nonce = genNonce();
  await updUser(c, uid, { state: "captcha_pending", verify_nonce: nonce, nonce_issued_at: Date.now() });

  const url = `${base}/verify?uid=${encodeURIComponent(uid)}&nonce=${encodeURIComponent(nonce)}`;
  await sendText(c, uid, "🛡️ <b>安全验证</b>\n请点击下方按钮完成人机验证。", {
    reply_markup: { inline_keyboard: [[{ text: "🔐 点击验证", web_app: { url } }]] }
  });
}

/**
 * 随机抽一题并记录题目 id：判定只认这道题的答案，
 * 否则脚本背熟任意一题答案就能通吃，随机抽题就失去意义了。
 */
async function sendQaQuestion(c, uid, isRetry) {
  const bank = await cfgJson(c, "qa_questions", []);
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
 */
async function handleQaAnswer(c, user, text) {
  const input = String(text || "").trim();
  const bank = await cfgJson(c, "qa_questions", []);

  if (!Array.isArray(bank) || !bank.length) {
    await markVerified(c, user.user_id);
    return true;
  }

  const current = bank.find(q => String(q.id) === String(user.qa_question_id));
  if (!current) {
    // 当前题被管理员删了：重新抽题，不判用户错
    await sendQaQuestion(c, user.user_id, false);
    return true;
  }

  if (input === String(current.a ?? "").trim()) {
    await markVerified(c, user.user_id);
    return true;
  }

  // 命令不判错：否则用户在题目改动后无法用 /start 自救
  if (input.startsWith("/")) return false;

  // 答错换题：题库越大，脚本枚举成本越高
  await sendQaQuestion(c, user.user_id, true);
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
  var UID = "${esc(uid)}", NONCE = "${esc(nonce)}";
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
    await advanceVerification(c, { ...user, state: "captcha_pending" }, identity.user);
    return json({ ok: true });
  }

  // nonce 一次性：校验通过立即作废，防重放
  const nonce = String(body?.nonce || "");
  const issuedAt = Number(user.nonce_issued_at || 0);
  const nonceOk =
    nonce && user.verify_nonce && timingSafeEqual(nonce, user.verify_nonce) && Date.now() - issuedAt <= NONCE_TTL_MS;
  if (!nonceOk) return json({ ok: false, error: "nonce invalid or expired" }, 403);

  if (!(await siteverify(c, mode, body?.token))) return json({ ok: false, error: "captcha failed" }, 403);

  await updUser(c, uid, {
    verify_nonce: null,
    nonce_issued_at: null,
    name: displayName(identity.user),
    username: identity.user?.username || null
  });

  await advanceVerification(c, { ...user, state: "captcha_pending" }, identity.user);
  return json({ ok: true });
}

// ============================================================
// §10 私聊处理
// ============================================================

async function handlePrivate(c, msg) {
  const uid = String(msg.chat.id);
  const text = msg.text || "";
  const admin = await isAdmin(c, uid);

  // 管理员路径：面板、命令、输入态，全程免验证免限流
  if (admin) return handleAdminPrivate(c, msg, uid, text);

  const user = await getUser(c, uid);

  // 屏蔽优先于一切：/start 也不解封（旧版曾在此处自愈解封，屏蔽形同虚设）
  if (user.is_blocked) {
    if (await shouldNotify(c, `blocked:${uid}`)) {
      await sendText(c, uid, "🚫 您已被管理员屏蔽，无法发送消息。");
    }
    return;
  }

  if ((await bumpBucket(c, `rl:${uid}`, RL_USER_WINDOW_MS)) > RL_USER_MAX) {
    if (await shouldNotify(c, `rlnotice:${uid}`)) {
      await sendText(c, uid, "⏳ 消息发送过于频繁，请稍后再试。");
    }
    return;
  }

  // 记录资料用于资料卡展示
  await updUser(c, uid, { name: displayName(msg.from), username: msg.from?.username || null });

  const isStart = text.startsWith("/start");

  if (user.state !== "verified") {
    // 问答阶段的非命令输入按答案处理
    if (user.state === "qa_pending" && text && !isStart) {
      const handled = await handleQaAnswer(c, user, text);
      if (handled) return;
    }

    if (isStart) await sendWelcome(c, uid, msg.from);
    return advanceVerification(c, user, msg.from);
  }

  if (isStart) {
    await sendText(c, uid, "✅ 您已完成验证，直接发送消息即可联系管理员。");
    return;
  }

  return relayToTopic(c, msg, user);
}

async function sendWelcome(c, uid, from) {
  const raw = await cfg(c, "welcome_msg");
  const name = esc(displayName(from));

  // 欢迎语可能是媒体配置 {type, file_id, caption}
  const media = raw.trim().startsWith("{") ? safeParse(raw, null) : null;
  if (media?.type && media?.file_id) {
    const method = { photo: "sendPhoto", video: "sendVideo", animation: "sendAnimation" }[media.type];
    const caption = String(media.caption || "").replace(/\{name\}/g, name);
    if (method) {
      const sent = await tgQuiet(c, method, {
        chat_id: uid,
        [media.type]: media.file_id,
        caption,
        parse_mode: "HTML"
      });
      if (sent) return;
    }
  }

  await sendText(c, uid, raw.replace(/\{name\}/g, name));
}

/** 用户编辑私聊消息 → 在其话题内提示 */
async function handleEditedMessage(c, msg) {
  const uid = String(msg.chat.id);
  if (await isAdmin(c, uid)) return;

  const user = await getUser(c, uid);
  if (!user.topic_id || user.is_blocked) return;

  const body = msg.text || msg.caption || "[非文本内容]";
  await sendToTopic(c, user, `✏️ <b>用户修改了消息：</b>\n${esc(body)}`);
}

// ============================================================
// §11 消息中继
// ============================================================

async function relayToTopic(c, msg, user) {
  const uid = user.user_id;
  const text = msg.text || msg.caption || "";

  // A. 屏蔽词：拦截 + 计数，达阈值自动封禁
  if (text) {
    const keywords = await cfgJson(c, "block_keywords", []);
    if (matchAny(keywords, text)) {
      const strikes = Number(user.strike_count || 0) + 1;
      const threshold = parseInt(await cfg(c, "block_threshold"), 10) || 5;

      if (strikes >= threshold) {
        await updUser(c, uid, { strike_count: strikes, is_blocked: true });
        await sendText(c, uid, "🚫 您已被系统自动封禁。");
        await syncBlacklistCard(c, { ...user, is_blocked: true, strike_count: strikes }, true);
        await refreshProfileCard(c, uid);
        return;
      }

      await updUser(c, uid, { strike_count: strikes });
      await sendText(c, uid, `⚠️ 消息含有违禁词，已被拦截 (${strikes}/${threshold})`);
      return;
    }
  }

  // B. 消息类型过滤
  const blockedType = await blockedTypeName(c, msg);
  if (blockedType) {
    await sendText(c, uid, `⚠️ 系统当前不接收${blockedType}。`);
    return;
  }

  // C. 自动回复（不影响正常转发）
  if (text) {
    const rules = await cfgJson(c, "auto_replies", []);
    const hit = (Array.isArray(rules) ? rules : []).find(r => r && matchKeyword(r.kw, text));
    if (hit) await sendText(c, uid, esc(hit.reply));
  }

  // D. 休息模式提示（冷却期内不重复打扰）
  if (await cfgBool(c, "busy_mode")) {
    const last = Number(user.last_busy_reply_at || 0);
    if (Date.now() - last > BUSY_REPLY_COOLDOWN_MS) {
      await sendText(c, uid, "🌙 " + esc(await cfg(c, "busy_msg")));
      await updUser(c, uid, { last_busy_reply_at: Date.now() });
    }
  }

  // E. 转发到专属话题
  const topicId = await ensureUserTopic(c, user, msg.from);
  await forwardToTopic(c, user, topicId, msg);
}

/**
 * 话题创建：一条原子条件 UPDATE 占位，无锁释放协议、无轮询。
 * 没抢到占位的请求抛 RetryLater → HTTP 500 → Telegram 按退避重投，届时话题已就绪。
 * 占位超过 TOPIC_CLAIM_STALE_MS 视为持有者已挂，允许接管，因此不会死锁。
 */
async function ensureUserTopic(c, user, from) {
  if (user.topic_id) return user.topic_id;

  const uid = user.user_id;
  const now = Date.now();

  const claimed = await dbRun(
    c,
    `UPDATE users SET topic_claim_ts = ?, updated_at = ?
     WHERE user_id = ? AND topic_id IS NULL
       AND (topic_claim_ts IS NULL OR topic_claim_ts < ?)`,
    [now, now, uid, now - TOPIC_CLAIM_STALE_MS]
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
    // 清占位让重投可以立即重试；清不掉也有 stale 兜底
    await updUser(c, uid, { topic_claim_ts: null });
    console.error("createForumTopic failed:", e?.message || e);
    throw new RetryLater("createForumTopic failed");
  }

  const topicId = Number(topic.message_thread_id);
  await updUser(c, uid, { topic_id: topicId, topic_claim_ts: null });
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
    if (recovered === "retry") throw new RetryLater("topic recovered, retry relay");

    if (recovered === "ok") {
      try {
        await tg(c, "copyMessage", payload);
        ok = true;
      } catch (e2) {
        const r2 = await handleTopicError(c, user, e2, "user");
        if (r2 === "retry") throw new RetryLater("topic recovered, retry relay");
        console.error("Relay failed:", e2?.message || e2);
      }
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

/** 向用户话题发文本（资料卡、编辑提示等） */
async function sendToTopic(c, user, html) {
  try {
    return await tg(c, "sendMessage", {
      chat_id: c.env.ADMIN_GROUP_ID,
      message_thread_id: user.topic_id,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    });
  } catch (e) {
    await handleTopicError(c, user, e, "user");
    return null;
  }
}

/**
 * 话题异常三分类（旧版只认"已删除"，话题被关闭后会静默失败直到人工重开）：
 *   已删除  → 清映射，下条消息自动重建
 *   已关闭  → 自动 reopen，成功则请求重试；失败降级按已删除处理
 *   其他    → 临时故障，不动映射（避免"报错→清空→重建"循环堆出一串话题）
 * 返回 "retry" 表示已恢复可重试，"gone" 表示映射已清，"ok" 表示非话题问题。
 */
async function handleTopicError(c, user, err, kind) {
  const m = String(err?.message || "");

  if (ERR_TOPIC_CLOSED.test(m)) {
    const reopened = await tgQuiet(c, "reopenForumTopic", {
      chat_id: c.env.ADMIN_GROUP_ID,
      message_thread_id: kind === "user" ? user.topic_id : user
    });
    if (reopened !== null) return "retry";
    // 重开失败（权限不足等）：按已删除处理，重建新话题
  } else if (!ERR_TOPIC_GONE.test(m)) {
    return "ok"; // 限流、网络等临时故障
  }

  if (kind === "user") {
    await updUser(c, user.user_id, { topic_id: null, topic_claim_ts: null, card_msg_id: null });
    user.topic_id = null;
  } else {
    await setCfg(c, "blacklist_topic_id", "");
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
  const card = await sendToTopic(c, user, profileCardText(data));
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
 * 黑名单共享话题：与用户话题同样的原子占位协议。
 * 没抢到占位时返回空——卡片是辅助路径，屏蔽状态本身已生效，卡片由后续操作补偿。
 */
async function ensureBlacklistTopic(c) {
  const existing = await cfg(c, "blacklist_topic_id");
  if (existing) return Number(existing);

  const now = Date.now();
  const lockKey = "blacklist_topic_claim";

  // UPDATE 影响 0 行时无法区分"没抢到"和"行不存在"，先确保锁行存在
  await dbRun(c, "INSERT OR IGNORE INTO config (key, value) VALUES (?, '0')", [lockKey]);

  const claimed = await dbRun(
    c,
    `UPDATE config SET value = ?
     WHERE key = ? AND (value = '0' OR CAST(value AS INTEGER) < ?)`,
    [String(now), lockKey, now - TOPIC_CLAIM_STALE_MS]
  );
  if (!claimed) {
    const retry = await dbFirst(c, "SELECT value FROM config WHERE key = 'blacklist_topic_id'");
    return retry?.value ? Number(retry.value) : 0;
  }

  try {
    const topic = await tg(c, "createForumTopic", { chat_id: c.env.ADMIN_GROUP_ID, name: "🚫 黑名单" });
    const id = Number(topic.message_thread_id);
    await setCfg(c, "blacklist_topic_id", String(id));
    return id;
  } catch (e) {
    console.error("create blacklist topic failed:", e?.message || e);
    return 0;
  } finally {
    await dbRun(c, "UPDATE config SET value = '0' WHERE key = ?", [lockKey]);
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

  try {
    const card = await tg(c, "sendMessage", {
      chat_id: c.env.ADMIN_GROUP_ID,
      message_thread_id: topicId,
      text: `<b>🚫 用户已屏蔽</b>\n${profileCardText({ ...user, is_blocked: true })}`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "✅ 解除屏蔽", callback_data: `unblock:${uid}` }]] }
    });
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
  if (!(await isAdmin(c, msg.from?.id))) return;
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

  if (!(await isAdmin(c, cb.from?.id))) return answer("无权限", true);

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

  if (text.trim() === "/cancel") {
    await delCfg(c, `admin_state:${uid}`);
    await sendText(c, uid, "已取消。");
    return renderPanel(c, uid, null, state.back || "home");
  }

  try {
    await applyAdminInput(c, state, msg, text);
  } catch (e) {
    return sendText(c, uid, `❌ ${esc(e.message)}`);
  }

  await delCfg(c, `admin_state:${uid}`);
  await sendText(c, uid, "✅ 已保存。");
  return renderPanel(c, uid, null, state.back || "home");
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
      const bank = await cfgJson(c, "qa_questions", []);
      bank.push({ id: String(Date.now()), q, a });
      return setCfg(c, "qa_questions", JSON.stringify(bank));
    }

    case "kw_add": {
      const kw = text.trim();
      if (!kw) throw new Error("关键词不能为空");
      const list = await cfgJson(c, "block_keywords", []);
      list.push(kw);
      return setCfg(c, "block_keywords", JSON.stringify(list));
    }

    case "ar_add": {
      const idx = text.indexOf("===");
      if (idx < 0) throw new Error("格式错误，请使用：关键词===回复内容");
      const kw = text.slice(0, idx).trim();
      const reply = text.slice(idx + 3).trim();
      if (!kw || !reply) throw new Error("关键词与回复内容都不能为空");
      const list = await cfgJson(c, "auto_replies", []);
      list.push({ id: String(Date.now()), kw, reply });
      return setCfg(c, "auto_replies", JSON.stringify(list));
    }

    default:
      throw new Error("未知的输入类型");
  }
}

async function registerCommands(c) {
  await tgQuiet(c, "setMyCommands", {
    commands: [{ command: "start", description: "开始" }],
    scope: { type: "default" }
  });
  for (const id of await getAdminSet(c)) {
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

  // 开关切换
  if (page === "toggle") {
    const cur = await cfgBool(c, arg1);
    await setCfg(c, arg1, cur ? "false" : "true");
    return renderPanel(c, uid, mid, arg2 || "home");
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

  // 列表删除
  if (page === "del") {
    if (arg1 === "qa") {
      const bank = (await cfgJson(c, "qa_questions", [])).filter(q => String(q.id) !== String(arg2));
      await setCfg(c, "qa_questions", JSON.stringify(bank));
      return renderPanel(c, uid, mid, "qa");
    }
    if (arg1 === "kw") {
      const list = await cfgJson(c, "block_keywords", []);
      const idx = Number(arg2);
      if (Number.isInteger(idx) && idx >= 0 && idx < list.length) list.splice(idx, 1);
      await setCfg(c, "block_keywords", JSON.stringify(list));
      return renderPanel(c, uid, mid, "kw");
    }
    if (arg1 === "ar") {
      const list = (await cfgJson(c, "auto_replies", [])).filter(r => String(r.id) !== String(arg2));
      await setCfg(c, "auto_replies", JSON.stringify(list));
      return renderPanel(c, uid, mid, "ar");
    }
  }

  // 进入输入态
  if (page === "input") {
    const spec = INPUT_SPECS[arg1];
    if (!spec) return;
    await setCfg(c, `admin_state:${uid}`, JSON.stringify({ field: arg1, back: spec.back }));

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
async function renderPanel(c, uid, mid, page) {
  const view = await buildPanelPage(c, page);
  const payload = {
    chat_id: uid,
    text: view.text,
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
  const qaOn = await cfgBool(c, "enable_qa");
  const bank = await cfgJson(c, "qa_questions", []);
  const emptyWarn = qaOn && !bank.length ? "\n\n⚠️ <b>题库为空，问答验证当前不生效。</b>" : "";

  return {
    text:
      "🛡️ <b>验证设置</b>\n\n" +
      `人机验证：${await captchaLabel(c)}\n` +
      `问答验证：${qaOn ? "✅ 开启" : "❌ 关闭"}（题库 ${bank.length} 题）${emptyWarn}`,
    keyboard: [
      [{ text: `人机验证：${await captchaLabel(c)}（点击切换）`, callback_data: "panel:captcha_rotate" }],
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
    text: `💬 <b>欢迎语</b>\n新用户首次 /start 时发送。\n\n<b>当前内容：</b>\n${preview(await cfg(c, "welcome_msg"))}`,
    keyboard: [[{ text: "✏️ 修改欢迎语", callback_data: "panel:input:welcome_msg" }], [BACK_HOME]]
  };
}

async function panelKeywords(c) {
  const list = await cfgJson(c, "block_keywords", []);
  const threshold = await cfg(c, "block_threshold");
  // 用索引作删除键：关键词是裸字符串，没有稳定 id
  const rows = list.map((kw, i) => [{ text: `🗑 ${String(kw).slice(0, 50)}`, callback_data: `panel:del:kw:${i}` }]);
  rows.push(
    [{ text: "➕ 添加屏蔽词", callback_data: "panel:input:kw_add" }],
    [{ text: `⚙️ 封禁阈值：${threshold} 次`, callback_data: "panel:input:block_threshold" }],
    [BACK_HOME]
  );

  return {
    text:
      "🚫 <b>屏蔽词</b>\n" +
      `命中后消息不转发并计违规，累计 ${esc(threshold)} 次自动封禁。\n\n` +
      (list.length ? `共 ${list.length} 条，点击可删除：` : "暂无屏蔽词。"),
    keyboard: rows
  };
}

async function panelAutoReplies(c) {
  const list = await cfgJson(c, "auto_replies", []);
  const rows = list.map(r => [
    { text: `🗑 ${String(r.kw).slice(0, 30)} → ${String(r.reply).slice(0, 20)}`, callback_data: `panel:del:ar:${r.id}` }
  ]);
  rows.push([{ text: "➕ 添加规则", callback_data: "panel:input:ar_add" }], [BACK_HOME]);

  return {
    text:
      "🤖 <b>自动回复</b>\n" +
      "命中关键词时自动回复用户，消息仍正常转发。\n\n" +
      (list.length ? `共 ${list.length} 条，点击可删除：` : "暂无规则。"),
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




