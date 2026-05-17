/**
 * EMOS iOS proxy app check-in script.
 *
 * Compatible with common script environments such as Surge, Loon,
 * Quantumult X, Stash, and Shadowrocket-style $httpClient runtimes.
 *
 * Setup:
 *   1. Fill TOKEN below, or store it as key "emos_token" in your app/BoxJs.
 *   2. Add this file as a scheduled/cron script in your iOS proxy app.
 */

const CONFIG = {
  BASE_URL: "https://emos.club",
  TOKEN: "", // Or leave empty and use persistent key: emos_token
  TOKEN_KEY: "emos_token",
  SIGN_CONTENT: "",
  SHOW_USER_INFO: true,
  TIMEOUT_MS: 15000,
};

const STORAGE_KEYS = {
  token: CONFIG.TOKEN_KEY,
};

function readStore(key) {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore.read) {
      return $persistentStore.read(key);
    }
    if (typeof $prefs !== "undefined" && $prefs.valueForKey) {
      return $prefs.valueForKey(key);
    }
  } catch (_) {}
  return "";
}

function notify(title, subtitle, body) {
  if (typeof body === "undefined") body = "";
  try {
    if (typeof $notification !== "undefined" && $notification.post) {
      $notification.post(title, subtitle, body);
      return;
    }
    if (typeof $notify !== "undefined") {
      $notify(title, subtitle, body);
      return;
    }
  } catch (_) {}
  console.log([title, subtitle, body].filter(Boolean).join(" - "));
}

function finish(value) {
  if (typeof $done !== "undefined") {
    $done(value || {});
  }
}

function buildUrl(path, query) {
  let url = CONFIG.BASE_URL.replace(/\/$/, "") + path;
  if (!query) return url;

  const params = [];
  Object.keys(query).forEach((key) => {
    if (query[key] !== undefined && query[key] !== null && query[key] !== "") {
      params.push(encodeURIComponent(key) + "=" + encodeURIComponent(query[key]));
    }
  });

  return params.length ? url + "?" + params.join("&") : url;
}

function request(method, path, token, query) {
  const options = {
    url: buildUrl(path, query),
    method,
    timeout: CONFIG.TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + token,
      "User-Agent": "emos-ios-checkin/1.0",
    },
  };

  return new Promise((resolve, reject) => {
    if (typeof $task !== "undefined" && $task.fetch) {
      $task.fetch(options).then(
        (response) => resolve({
          statusCode: response.statusCode || response.status,
          body: response.body || "",
        }),
        reject
      );
      return;
    }

    if (typeof $httpClient !== "undefined") {
      const callback = (error, response, data) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          statusCode: (response && (response.status || response.statusCode)) || 0,
          body: data || "",
        });
      };

      const lower = method.toLowerCase();
      if (lower === "get") $httpClient.get(options, callback);
      else if (lower === "put") $httpClient.put(options, callback);
      else if (lower === "post") $httpClient.post(options, callback);
      else reject(new Error("Unsupported method: " + method));
      return;
    }

    if (typeof fetch !== "undefined") {
      fetch(options.url, { method, headers: options.headers })
        .then((response) => response.text().then((body) => resolve({
          statusCode: response.status,
          body,
        })))
        .catch(reject);
      return;
    }

    reject(new Error("No supported HTTP client found."));
  });
}

function parseJson(response) {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error("HTTP " + response.statusCode + ": " + response.body);
  }

  if (!response.body) return {};

  try {
    return JSON.parse(response.body);
  } catch (_) {
    throw new Error("Invalid JSON: " + response.body.slice(0, 120));
  }
}

async function api(method, path, token, query) {
  return parseJson(await request(method, path, token, query));
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

async function main() {
  const token = CONFIG.TOKEN || readStore(STORAGE_KEYS.token);
  if (!token) {
    notify("EMOS 签到", "缺少 token", "请填写脚本里的 CONFIG.TOKEN，或保存持久化变量 emos_token。");
    return;
  }

  const status = await api("GET", "/api/sign/check", token);
  let subtitle = "";
  let body = "";

  if (status.is_sign === true) {
    subtitle = "今天已经签到";
  } else {
    await api("PUT", "/api/user/sign", token, { content: CONFIG.SIGN_CONTENT });
    subtitle = "签到成功";
  }

  if (CONFIG.SHOW_USER_INFO) {
    try {
      body = formatUser(await api("GET", "/api/user", token));
    } catch (error) {
      body = "已完成签到，但获取账号信息失败：" + error.message;
    }
  }

  notify("EMOS 签到", subtitle, body);
}

main()
  .catch((error) => {
    notify("EMOS 签到失败", "", error.message || String(error));
  })
  .finally(() => finish());
