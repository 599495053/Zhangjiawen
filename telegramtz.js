/*
CLIENT 可选：
Telegram / Swiftgram / Turrit / iMe / Nicegram / Lingogram
*/

const url = $request.url;
const arg = typeof $argument !== "undefined" ? $argument : "";
const client = (arg.match(/CLIENT=([^&]+)/)?.[1] || "Telegram").trim();

const schemes = {
  Telegram: "tg",
  Swiftgram: "swiftgram",
  Turrit: "turrit",
  iMe: "ime",
  Nicegram: "nicegram",
  Lingogram: "lingogram",
};

const scheme = schemes[client] || "tg";

function buildUrl(raw) {
  const u = new URL(raw);
  const parts = u.pathname.split("/").filter(Boolean);

  if (parts.length === 0) return `${scheme}://`;

  // https://t.me/+xxxx
  if (parts[0].startsWith("+")) {
    return `${scheme}://join?invite=${encodeURIComponent(parts[0].slice(1))}`;
  }

  // https://t.me/joinchat/xxxx
  if (parts[0] === "joinchat" && parts[1]) {
    return `${scheme}://join?invite=${encodeURIComponent(parts[1])}`;
  }

  // https://t.me/s/username/123
  if (parts[0] === "s" && parts[1]) {
    const domain = encodeURIComponent(parts[1]);
    const post = parts[2] ? `&post=${encodeURIComponent(parts[2])}` : "";
    return `${scheme}://resolve?domain=${domain}${post}`;
  }

  // https://t.me/username/123
  const domain = encodeURIComponent(parts[0]);
  const post = parts[1] ? `&post=${encodeURIComponent(parts[1])}` : "";

  return `${scheme}://resolve?domain=${domain}${post}`;
}

const target = buildUrl(url);

$done({
  response: {
    status: 302,
    headers: {
      Location: target,
    },
  },
});