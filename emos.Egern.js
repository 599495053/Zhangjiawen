/**
 * EMOS Egern check-in script (multi-account v4).
 *
 * Egern 配置示例：
 * scriptings:
 *   - schedule:
 *       name: "EMOS 多账号签到"
 *       cron: "0 8 * * *"
 *       script_url: "你的脚本地址"
 *       env:
 *         emos_tokens: "token1\ntoken2\ntoken3"
 *       timeout: 120
 *
 * 支持 env：
 * - emos_tokens / EMOS_TOKENS：多账号 token，支持换行、英文逗号、|、JSON 数组
 * - emos_token / EMOS_TOKEN：单账号 token，兼容旧配置
 */

const CONFIG = {
  BASE_URL: "https://emos.club",
  TOKENS: [],
  TOKEN: "",
  TOKEN_KEYS: ["emos_token", "EMOS_TOKEN"],
  TOKENS_KEYS: ["emos_tokens", "EMOS_TOKENS"],
  SIGN_CONTENT: "",
  SHOW_USER_INFO: true,
  TIMEOUT_MS: 15000,
};

function unique(arr) {
  const seen = {};
  const out = [];
  for (const item of arr) {
    const v = String(item || "").trim();
    if (v && !seen[v]) {
      seen[v] = true;
      out.push(v);
    }
  }
  return out;
}

function parseTokens(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];

  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return unique(parsed);
      if (typeof parsed === "string") return unique([parsed]);
    } catch (_) {}
  }

  return unique(raw.split(/[\n,|，]+/));
}

function getTokens(ctx) {
  const env = (ctx && ctx.env) || {};
  let tokens = [];

  for (const key of CONFIG.TOKENS_KEYS) {
    tokens = tokens.concat(parseTokens(env[key]));
  }
  for (const key of CONFIG.TOKEN_KEYS) {
    tokens = tokens.concat(parseTokens(env[key]));
  }
  tokens = tokens.concat(parseTokens(CONFIG.TOKEN));
  tokens = tokens.concat(CONFIG.TOKENS || []);

  return unique(tokens.map((t) => String(t).replace(/^Bearer\s+/i, "").trim()));
}

function maskToken(token) {
  if (!token) return "";
  if (token.length <= 10) return token.slice(0, 2) + "***";
  return token.slice(0, 5) + "***" + token.slice(-4);
}

function buildUrl(path, query) {
  let url = CONFIG.BASE_URL.replace(/\/$/, "") + path;
  const params = [];
  Object.keys(query || {}).forEach((key) => {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") {
      params.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    }
  });
  return params.length ? url + "?" + params.join("&") : url;
}

async function request(ctx, method, path, token, query, body, extraHeaders) {
  if (!ctx || !ctx.http) throw new Error("当前脚本不是 Egern ctx 运行环境");

  const headers = {
    Accept: "application/json",
    Authorization: "Bearer " + token,
    Origin: CONFIG.BASE_URL,
    Referer: CONFIG.BASE_URL + "/",
    "User-Agent": "Mozilla/5.0 EMOS-Egern-Checkin/1.4",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders || {});

  const options = { timeout: CONFIG.TIMEOUT_MS, headers };
  if (body !== undefined) options.body = body;

  const lower = method.toLowerCase();
  if (!ctx.http[lower]) throw new Error("Unsupported method: " + method);

  const resp = await ctx.http[lower](buildUrl(path, query), options);
  const text = await resp.text();
  return { status: resp.status, body: text };
}

function parseJson(response) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error("HTTP " + response.status + ": " + response.body.slice(0, 300));
  }
  if (!response.body) return {};
  try {
    return JSON.parse(response.body);
  } catch (_) {
    throw new Error("Invalid JSON: " + response.body.slice(0, 120));
  }
}

async function api(ctx, method, path, token, query, body, extraHeaders) {
  return parseJson(await request(ctx, method, path, token, query, body, extraHeaders));
}

function pad2(n) { return n < 10 ? "0" + n : String(n); }
function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function todayLocalDate() { return ymd(new Date()); }
function todayUtcDate() { return new Date().toISOString().slice(0, 10); }

function extractSignAt(user) {
  if (!user || typeof user !== "object") return "";
  const sign = user.sign && typeof user.sign === "object" ? user.sign : {};
  return String(sign.sign_at || user.sign_at || "");
}

function isSignedToday(user) {
  const signAt = extractSignAt(user);
  if (!signAt) return false;
  const d = signAt.slice(0, 10);
  return d === todayLocalDate() || d === todayUtcDate();
}

function accountName(user, index) {
  if (user && typeof user === "object") {
    return user.pseudonym || user.username || user.name || user.email || ("账号" + index);
  }
  return "账号" + index;
}

function formatOne(user, index, subtitle) {
  const sign = user && user.sign && typeof user.sign === "object" ? user.sign : {};
  const parts = ["#" + index + " " + accountName(user, index) + "：" + subtitle];
  if (CONFIG.SHOW_USER_INFO) {
    if (typeof user.carrot !== "undefined") parts.push("胡萝卜 " + user.carrot);
    if (sign.continuous_days) parts.push("连续 " + sign.continuous_days + " 天");
    if (sign.sign_at) parts.push("签到 " + sign.sign_at);
  }
  return parts.join("，");
}

function notify(ctx, title, subtitle, body) {
  if (ctx && ctx.notify) ctx.notify({ title, subtitle: subtitle || "", body: body || "" });
}

async function getUser(ctx, token) {
  return await api(ctx, "GET", "/api/user", token);
}

async function trySign(ctx, token) {
  const query = CONFIG.SIGN_CONTENT ? { content: CONFIG.SIGN_CONTENT } : undefined;
  const attempts = [
    { name: "PUT body object", body: {} },
    { name: "PUT no body", body: undefined },
    { name: "PUT body string", body: "{}" },
  ];

  let lastError = "";
  for (const a of attempts) {
    const resp = await request(ctx, "PUT", "/api/user/sign", token, query, a.body);
    if (resp.status >= 200 && resp.status < 300) return { ok: true, response: resp, attempt: a.name };

    lastError = a.name + " -> HTTP " + resp.status + ": " + resp.body.slice(0, 200);

    try {
      const user = await getUser(ctx, token);
      if (isSignedToday(user)) return { ok: true, already: true, user, attempt: a.name, error: lastError };
    } catch (_) {}
  }
  throw new Error("签到接口全部失败，最后错误：" + lastError);
}

async function checkinOne(ctx, token, index) {
  let user = await getUser(ctx, token);
  let subtitle = "";

  if (isSignedToday(user)) {
    subtitle = "今天已经签到";
  } else {
    const result = await trySign(ctx, token);
    user = result.user || await getUser(ctx, token);
    if (isSignedToday(user)) {
      subtitle = result.already ? "今天已经签到" : "签到成功";
    } else {
      throw new Error("签到请求返回成功，但 /api/user 未显示今天签到。sign_at=" + (extractSignAt(user) || "空"));
    }
  }

  return { ok: true, index, token, user, subtitle, line: formatOne(user, index, subtitle) };
}

export default async function(ctx) {
  const tokens = getTokens(ctx);
  if (!tokens.length) {
    notify(ctx, "EMOS 签到", "缺少 token", "请在 Egern env 中设置 emos_tokens；多账号可用换行、英文逗号或 | 分隔。token 是网页 localStorage 里的 activeToken，不要带 Bearer 前缀。 ");
    return;
  }

  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    const index = i + 1;
    try {
      results.push(await checkinOne(ctx, tokens[i], index));
    } catch (error) {
      results.push({
        ok: false,
        index,
        token: tokens[i],
        line: "#" + index + " 签到失败：" + (error.message || String(error)) + "，token=" + maskToken(tokens[i]),
      });
    }
  }

  const success = results.filter((r) => r.ok).length;
  const failed = results.length - success;
  notify(ctx, "EMOS 多账号签到", "成功 " + success + " / " + results.length + (failed ? "，失败 " + failed : ""), results.map((r) => r.line).join("\n"));
}