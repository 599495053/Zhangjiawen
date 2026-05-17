/**
 * EMOS Egern check-in script.
 *
 * Egern 用法：
 * scriptings:
 *   - schedule:
 *       name: "EMOS 签到"
 *       cron: "0 8 * * *"
 *       script_url: "https://raw.githubusercontent.com/599495053/Zhangjiawen/refs/heads/main/emos_checkin_ios.js"
 *       env:
 *         emos_token: "你的 token"
 *       timeout: 60
 */

const CONFIG = {
  BASE_URL: "https://emos.club",
  TOKEN: "", // 也可直接填 token；优先级低于 ctx.env.emos_token
  TOKEN_KEYS: ["emos_token", "EMOS_TOKEN"],
  SIGN_CONTENT: "",
  SHOW_USER_INFO: true,
  TIMEOUT_MS: 15000,
};

function getToken(ctx) {
  const env = (ctx && ctx.env) || {};
  for (const key of CONFIG.TOKEN_KEYS) {
    if (env[key]) return String(env[key]).trim();
  }
  return String(CONFIG.TOKEN || "").trim();
}

function buildUrl(path, query) {
  let url = CONFIG.BASE_URL.replace(/\/$/, "") + path;
  if (!query) return url;

  const params = [];
  Object.keys(query).forEach((key) => {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") {
      params.push(encodeURIComponent(key) + "=" + encodeURIComponent(value));
    }
  });
  return params.length ? url + "?" + params.join("&") : url;
}

async function request(ctx, method, path, token, query) {
  if (!ctx || !ctx.http) throw new Error("当前脚本不是 Egern ctx 运行环境");

  const url = buildUrl(path, query);
  const options = {
    timeout: CONFIG.TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
      "User-Agent": "emos-ios-checkin/egern-1.0",
    },
  };

  const lower = method.toLowerCase();
  if (!ctx.http[lower]) throw new Error("Unsupported method: " + method);

  const resp = await ctx.http[lower](url, options);
  const body = await resp.text();
  return { status: resp.status, body };
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

async function api(ctx, method, path, token, query) {
  return parseJson(await request(ctx, method, path, token, query));
}

function formatUser(user) {
  if (!user || typeof user !== "object") return "";

  const sign = user.sign && typeof user.sign === "object" ? user.sign : {};
  const lines = [];

  if (user.pseudonym || user.username) lines.push("账号：" + (user.pseudonym || user.username));
  if (typeof user.carrot !== "undefined") lines.push("胡萝卜：" + user.carrot);
  if (sign.continuous_days) lines.push("连续签到：" + sign.continuous_days + " 天");
  if (sign.sign_at) lines.push("签到时间：" + sign.sign_at);

  return lines.join("\n");
}

function notify(ctx, title, subtitle, body) {
  if (ctx && ctx.notify) {
    ctx.notify({ title, subtitle: subtitle || "", body: body || "" });
  }
}

export default async function(ctx) {
  try {
    const token = getToken(ctx);
    if (!token) {
      notify(ctx, "EMOS 签到", "缺少 token", "请在 Egern 脚本 env 中设置 emos_token，或填入 CONFIG.TOKEN。注意 env 需配置在该脚本/模块下。 ");
      return;
    }

    const status = await api(ctx, "GET", "/api/sign/check", token);
    let subtitle = "";
    let body = "";

    if (status.is_sign === true) {
      subtitle = "今天已经签到";
    } else {
      await api(ctx, "PUT", "/api/user/sign", token, { content: CONFIG.SIGN_CONTENT });
      subtitle = "签到成功";
    }

    if (CONFIG.SHOW_USER_INFO) {
      try {
        body = formatUser(await api(ctx, "GET", "/api/user", token));
      } catch (error) {
        body = "已完成签到，但获取账号信息失败：" + (error.message || String(error));
      }
    }

    notify(ctx, "EMOS 签到", subtitle, body);
  } catch (error) {
    notify(ctx, "EMOS 签到失败", "", error.message || String(error));
  }
}