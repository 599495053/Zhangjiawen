/*
 * EMOS Surge check-in script (multi-account).
 *
 * 支持读取方式：
 * 1) $argument 传参：emos_tokens=token1\ntoken2 或 emos_token=单个token
 * 2) $persistentStore：emos_tokens / emos_token
 *
 * 示例（Surge 脚本本体不写死参数时，可在运行环境里设置 persistentStore）
 */

const CONFIG = {
  BASE_URL: "https://emos.club",
  TIMEOUT_MS: 15000,
  SHOW_USER_INFO: true,
  SIGN_CONTENT: "",
  TOKEN_KEYS: ["emos_token", "EMOS_TOKEN"],
  TOKENS_KEYS: ["emos_tokens", "EMOS_TOKENS"],
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

function parseQueryString(qs) {
  const obj = {};
  const raw = String(qs || "").replace(/^\?/, "");
  if (!raw) return obj;
  raw.split("&").forEach((pair) => {
    if (!pair) return;
    const idx = pair.indexOf("=");
    const k = idx >= 0 ? pair.slice(0, idx) : pair;
    const v = idx >= 0 ? pair.slice(idx + 1) : "";
    obj[decodeURIComponent(k.replace(/\+/g, "%20"))] = decodeURIComponent(v.replace(/\+/g, "%20"));
  });
  return obj;
}

function getArgs() {
  if (typeof $argument === "undefined" || !$argument) return {};
  return parseQueryString($argument);
}

function getStore(key) {
  try {
    return typeof $persistentStore !== "undefined" ? $persistentStore.read(key) : "";
  } catch (_) {
    return "";
  }
}

function getTokens() {
  const args = getArgs();
  let tokens = [];

  CONFIG.TOKENS_KEYS.forEach((key) => {
    tokens = tokens.concat(parseTokens(args[key])).concat(parseTokens(getStore(key)));
  });
  CONFIG.TOKEN_KEYS.forEach((key) => {
    tokens = tokens.concat(parseTokens(args[key])).concat(parseTokens(getStore(key)));
  });

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

function request(method, path, token, query, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: "application/json",
      Authorization: "Bearer " + token,
      Origin: CONFIG.BASE_URL,
      Referer: CONFIG.BASE_URL + "/",
      "User-Agent": "Mozilla/5.0 EMOS-Surge-Checkin/1.0",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    Object.assign(headers, extraHeaders || {});

    const options = { url: buildUrl(path, query), headers };
    if (body !== undefined) options.body = body;

    const fn = $httpClient[method.toLowerCase()];
    if (!fn) return reject(new Error("Unsupported method: " + method));

    fn(options, (error, response, data) => {
      if (error) return reject(error);
      resolve({
        status: response.status,
        body: typeof data === "string" ? data : String(data || ""),
      });
    });
  });
}

async function api(method, path, token, query, body, extraHeaders) {
  const resp = await request(method, path, token, query, body, extraHeaders);
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error("HTTP " + resp.status + ": " + resp.body.slice(0, 300));
  }
  if (!resp.body) return {};
  try {
    return JSON.parse(resp.body);
  } catch (_) {
    throw new Error("Invalid JSON: " + resp.body.slice(0, 120));
  }
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

function notify(title, subtitle, body) {
  $notification.post(title, subtitle || "", body || "");
}

async function getUser(token) {
  return await api("GET", "/api/user", token);
}

async function trySign(token) {
  const query = CONFIG.SIGN_CONTENT ? { content: CONFIG.SIGN_CONTENT } : undefined;
  const attempts = [
    { name: "PUT body object", body: {} },
    { name: "PUT no body", body: undefined },
    { name: "PUT body string", body: "{}" },
  ];

  let lastError = "";
  for (const a of attempts) {
    const resp = await request("PUT", "/api/user/sign", token, query, a.body);
    if (resp.status >= 200 && resp.status < 300) return { ok: true, response: resp, attempt: a.name };

    lastError = a.name + " -> HTTP " + resp.status + ": " + resp.body.slice(0, 200);

    try {
      const user = await getUser(token);
      if (isSignedToday(user)) return { ok: true, already: true, user, attempt: a.name, error: lastError };
    } catch (_) {}
  }
  throw new Error("签到接口全部失败，最后错误：" + lastError);
}

async function checkinOne(token, index) {
  let user = await getUser(token);
  let subtitle = "";

  if (isSignedToday(user)) {
    subtitle = "今天已经签到";
  } else {
    const result = await trySign(token);
    user = result.user || await getUser(token);
    if (isSignedToday(user)) {
      subtitle = result.already ? "今天已经签到" : "签到成功";
    } else {
      throw new Error("签到请求返回成功，但 /api/user 未显示今天签到。sign_at=" + (extractSignAt(user) || "空"));
    }
  }

  return { ok: true, index, token, user, subtitle, line: formatOne(user, index, subtitle) };
}

(async () => {
  try {
    const tokens = getTokens();
    if (!tokens.length) {
      notify("EMOS 签到", "缺少 token", "请在 $persistentStore 或 $argument 中设置 emos_tokens；多账号可用换行、英文逗号或 | 分隔。token 是网页 localStorage 里的 activeToken，不要带 Bearer 前缀。");
      return $done();
    }

    const results = [];
    for (let i = 0; i < tokens.length; i++) {
      const index = i + 1;
      try {
        results.push(await checkinOne(tokens[i], index));
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
    notify("EMOS 多账号签到", "成功 " + success + " / " + results.length + (failed ? "，失败 " + failed : ""), results.map((r) => r.line).join("\n"));
    return $done();
  } catch (e) {
    notify("EMOS 多账号签到", "执行失败", e && e.message ? e.message : String(e));
    return $done();
  }
})();
