// 拼多多去广告 · 扫码取件页脚本（Surge http-response）
// 对应 Loon 原插件中 m.pinduoduo.net/mdkd/package 的脚本逻辑：
// 1) 把页面引用的旧 chunk 换成可莉提供的去广告 chunk；
// 2) 移除 index_gif-container 动图推广容器；
// 3) __NEXT_DATA__ 里只保留取件必需的两个数据块，去掉商品推荐与弹窗数据。
// 用法（二选一）：a) 直接用 .sgmodule 里已填好的公开镜像 script-path，无需本文件；
//                b) 把本文件托管到你自己的 GitHub/Gist，再把模块里 script-path 换成你的 raw 地址。

let body = $response.body || "";

const OLD_CHUNK = "https://pfile.pddpic.com/mdkd/mdkd/_next/static/chunks/9410-b8806e870a26db7d.js";
const NEW_CHUNK = "https://kelee.one/Resource/JavaScript/PinDuoDuo/9410-b8806e870a26db7d.js";

function replaceAllText(text, from, to) {
  let pos = text.indexOf(from);
  while (pos !== -1) {
    text = text.slice(0, pos) + to + text.slice(pos + from.length);
    pos = text.indexOf(from, pos + to.length);
  }
  return text;
}

function removeGifContainer(html) {
  const marker = "index_gif-container";
  let pos = html.indexOf(marker);
  while (pos !== -1) {
    const open = html.lastIndexOf("<div", pos);
    if (open === -1) break;
    let i = open, depth = 0, end = -1;
    while (i < html.length) {
      const nextOpen = html.indexOf("<div", i);
      const nextClose = html.indexOf("</div>", i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        i = nextClose + 6;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    html = html.slice(0, open) + html.slice(end);
    pos = html.indexOf(marker, open);
  }
  return html;
}

function trimNextData(html) {
  const idPos = html.indexOf('id="__NEXT_DATA__"');
  if (idPos === -1) return html;
  const tagStart = html.lastIndexOf("<script", idPos);
  if (tagStart === -1) return html;
  const contentStart = html.indexOf(">", tagStart);
  if (contentStart === -1) return html;
  const tagEnd = html.indexOf("</script>", contentStart);
  if (tagEnd === -1) return html;
  try {
    const data = JSON.parse(html.slice(contentStart + 1, tagEnd));
    const serverData = data && data.props && data.props.pageProps && data.props.pageProps.serverData;
    if (Array.isArray(serverData)) {
      data.props.pageProps.serverData = serverData.filter(item =>
        item && (item.key === "fastBindCMobilePreCheck" || item.key === "queryStationPackageInfo"));
    }
    return html.slice(0, contentStart + 1) + JSON.stringify(data) + html.slice(tagEnd);
  } catch (e) {
    return html;
  }
}

body = replaceAllText(body, OLD_CHUNK, NEW_CHUNK);
body = removeGifContainer(body);
body = trimNextData(body);

$done({ body });
