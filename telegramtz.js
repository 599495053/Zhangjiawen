const url = $request.url;
const arg = typeof $argument !== "undefined" ? $argument : "";
const client = (arg.match(/CLIENT=([^&]+)/) || [])[1] || "Telegram";

const schemes = {
  Telegram: "tg://resolve?",
  Swiftgram: "swiftgram://resolve?",
  Turrit: "turrit://resolve?",
  iMe: "ime://resolve?",
  Nicegram: "nicegram://resolve?",
  Lingogram: "lingogram://resolve?"
};

function buildRedirect(tmeUrl) {
  const u = new URL(tmeUrl);
  const parts = u.pathname.split("/").filter(Boolean);

  if (parts.length === 0) return tmeUrl;

  const domain = parts[0];
  const params = new URLSearchParams();

  if (domain.startsWith("+")) {
    return `${schemes[client] || schemes.Telegram}domain=${encodeURIComponent(domain)}`;
  }

  params.set("domain", domain);

  if (parts[1]) {
    params.set("post", parts[1]);
  }

  for (const [k, v] of u.searchParams.entries()) {
    params.set(k, v);
  }

  return `${schemes[client] || schemes.Telegram}${params.toString()}`;
}

$done({
  response: {
    status: 302,
    headers: {
      Location: buildRedirect(url)
    }
  }
});