/**
 * Sub-Store 流量查询小组件
 *
 * 环境变量示例：
 *
 *   SUB_STORE_BASE_URL=http://192.168.1.100:3000   # Sub-Store 地址（优先级最高）
 *   SUB_STORE_URL=http://sub.store                  # 备用 Sub-Store 地址
 *   BASE_URL=http://sub.store                       # 备用 Sub-Store 地址
 *
 *   SUB_NAMES=机场A,机场B                            # 指定显示的订阅名称（逗号/换行/管道符分隔）
 *                                                    # 不设置则显示全部订阅
 *   MATCH_CONTAINS=true                             # 订阅名称模糊匹配（默认 false 精确匹配）
 *
 *   TITLE=我的套餐                                   # 小组件标题（默认 "Sub-Store 套餐"）
 *   OPEN_URL=https://sub-store.vercel.app            # 点击小组件打开的地址
 *   MAX_ITEMS=3                                      # 最多显示几个订阅（默认按小组件尺寸自动）
 *   REFRESH_MINUTES=30                               # 刷新间隔分钟数（默认 30，最小 5）
 *   TIMEOUT_MS=8000                                  # 请求超时毫秒数（默认 8000）
 *   FLOW_USER_AGENT=clash.meta/v1.19.23              # 流量查询 User-Agent
 *   INSECURE_TLS=false                               # 允许不安全的 HTTPS（默认 false）
 *   USE_CACHE=true                                   # 启用缓存（默认 true）
 *   HIDE_ERRORS=false                                # 隐藏错误订阅（默认 false）
 *
 *   RESET_DAY=1                                      # 每月几号重置流量（1-31）
 *   START_DATE=2024-01-15                            # 周期重置起始日期
 *   CYCLE_DAYS=30                                    # 周期重置天数
 *   RESET_RULES={"机场A":{"resetDay":"5"}}            # 按订阅名单独设置重置规则
 *
 */

export default async function (ctx) {
  const cfg = getConfig(ctx);
  const cache = readCache(ctx, cfg);

  try {
    const subs = await fetchSubscriptions(ctx, cfg);
    const selected = selectSubscriptions(subs, cfg);
    if (!selected.length) {
      return errorWidget(cfg, '未找到订阅', 'SUB_NAMES 没有匹配到 Sub-Store 里的订阅名称');
    }

    const items = [];
    const selectedItems = selected.slice(0, cfg.maxItems);
    await Promise.all(selectedItems.map(async (sub, index) => {
      items[index] = await fetchFlowItem(ctx, cfg, sub);
    }));

    const payload = {
      at: Date.now(),
      source: cfg.baseUrl,
      items: cfg.hideErrors ? items.filter((item) => !item.error) : items,
    };
    writeCache(ctx, cfg, payload);
    return renderWidget(cfg, payload, false);
  } catch (e) {
    if (cache && Array.isArray(cache.items) && cache.items.length) {
      return renderWidget(cfg, cache, true, shortError(e));
    }
    return errorWidget(cfg, 'Sub-Store 连接失败', shortError(e));
  }
}

function getConfig(ctx) {
  const env = ctx.env || {};
  const family = ctx.widgetFamily || 'systemMedium';
  const defaultMax = {
    accessoryInline: 1,
    accessoryCircular: 1,
    accessoryRectangular: 1,
    systemSmall: 1,
    systemMedium: 3,
    systemLarge: 6,
    systemExtraLarge: 8,
  }[family] || 3;

  const baseUrls = unique([
    env.SUB_STORE_BASE_URL,
    env.SUB_STORE_URL,
    env.BASE_URL,
    'http://sub.store',
    'https://sub.store',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ].map(normalizeBaseUrl).filter(Boolean));

  return {
    family,
    title: env.TITLE || 'Sub-Store 套餐',
    baseUrl: baseUrls[0] || 'http://sub.store',
    baseUrls,
    openUrl: env.OPEN_URL || 'https://sub-store.vercel.app',
    names: parseList(env.SUB_NAMES || env.SUB_NAME || env.SUBS || ''),
    matchContains: bool(env.MATCH_CONTAINS, false),
    maxItems: clampInt(env.MAX_ITEMS, defaultMax, 1, 12),
    refreshMinutes: clampInt(env.REFRESH_MINUTES, 30, 5, 1440),
    timeout: clampInt(env.TIMEOUT_MS || env.TIMEOUT, 8000, 1000, 60000),
    flowUserAgent: env.FLOW_USER_AGENT || 'clash.meta/v1.19.23',
    insecureTls: bool(env.INSECURE_TLS, false),
    useCache: bool(env.USE_CACHE, true),
    hideErrors: bool(env.HIDE_ERRORS, false),
    cacheKey: env.CACHE_KEY || 'substore-flow-widget-cache-v2',
    resetDay: env.RESET_DAY || '',
    startDate: env.START_DATE || '',
    cycleDays: env.CYCLE_DAYS || '',
    resetRules: parseResetRules(env.RESET_RULES || ''),
  };
}

async function fetchSubscriptions(ctx, cfg) {
  const storedSubs = readStoredSubscriptions(ctx);
  if (storedSubs.length) return storedSubs;

  let lastError;
  const urls = Array.isArray(cfg.baseUrls) && cfg.baseUrls.length ? cfg.baseUrls : [cfg.baseUrl];
  for (const base of urls) {
    try {
      const json = await requestJson(ctx, apiUrl(base, '/api/subs'), cfg);
      const data = unwrapData(json);
      let subs = null;
      if (Array.isArray(data)) subs = data.filter(Boolean);
      else if (data && typeof data === 'object') subs = Object.values(data).filter(Boolean);
      if (subs) {
        cfg.baseUrl = base;
        return subs;
      }
      throw new Error('订阅列表格式异常');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('无法连接 Sub-Store');
}

function selectSubscriptions(subs, cfg) {
  if (!cfg.names.length) return subs.filter(isRemoteSub);
  return cfg.names.map((name) => {
    const wanted = String(name).trim();
    let found = subs.find((s) => String(s?.name || '') === wanted);
    if (!found && cfg.matchContains) {
      found = subs.find((s) => String(s?.name || '').includes(wanted));
    }
    return found || { name: wanted, missing: true };
  });
}

function isRemoteSub(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (sub.subUserinfo) return true;
  if (sub.source === 'remote') return true;
  if (sub.url && /^https?:\/\//i.test(String(sub.url).trim())) return true;
  return false;
}

async function fetchFlowItem(ctx, cfg, sub) {
  const name = String(sub && sub.name ? sub.name : '未命名订阅');
  if (sub.missing) {
    return {
      name,
      error: '订阅不存在',
    };
  }

  try {
    const storedFlow = readStoredFlow(ctx, name);
    if (storedFlow) return decorateItem(sub, storedFlow, cfg);

    if (sub.__apiFlowUrl) {
      try {
        const json = await requestJson(ctx, sub.__apiFlowUrl, cfg);
        const flow = normalizeFlow(unwrapData(json));
        if (hasUsableFlow(flow)) return decorateItem(sub, flow, cfg);
      } catch (_) {}
    }

    const json = await requestJson(
      ctx,
      apiUrl(cfg.baseUrl, '/api/sub/flow/' + encodeURIComponent(name)),
      cfg,
    );
    const flow = normalizeFlow(unwrapData(json));
    if (!hasUsableFlow(flow)) throw new Error('无可用流量信息');
    return decorateItem(sub, flow, cfg);
  } catch (e) {
    try {
      const directFlow = await fetchDirectFlow(ctx, cfg, sub);
      if (hasUsableFlow(directFlow)) return decorateItem(sub, directFlow, cfg);
    } catch (_) {}
    return {
      name,
      error: shortError(e),
    };
  }
}

async function fetchDirectFlow(ctx, cfg, sub) {
  const raw = firstHttpUrl(sub.url || sub.subUserinfo || '');
  if (!raw) throw new Error('订阅链接不可用');
  const parts = splitUrlArgs(raw);
  const args = parts.args;
  if (args.noFlow) throw new Error('noFlow');

  const url = args.flowUrl || parts.url;
  const headers = {
    'User-Agent': args.flowUserAgent || cfg.flowUserAgent,
  };
  Object.assign(headers, parseHeaderObject(args.flowHeaders || args.headers));

  const opt = {
    headers,
    timeout: cfg.timeout,
    redirect: 'follow',
    insecureTls: cfg.insecureTls || !!args.insecure,
  };

  if (args.flowUrl) {
    const resp = await ctx.http.get(url, opt);
    const bodyFlow = parseFlowString(await safeText(resp));
    if (hasUsableFlow(bodyFlow)) return bodyFlow;
    const headerFlow = parseFlowHeaders(resp.headers);
    if (hasUsableFlow(headerFlow)) return headerFlow;
  }

  try {
    const resp = await ctx.http.head(url, opt);
    const flow = parseFlowHeaders(resp.headers);
    if (hasUsableFlow(flow)) return flow;
  } catch (_) {}

  const resp = await ctx.http.get(url, opt);
  const flow = parseFlowHeaders(resp.headers);
  if (hasUsableFlow(flow)) return flow;
  throw new Error('响应头未包含流量信息');
}

function decorateItem(sub, flow, cfg) {
  const total = num(flow.total);
  const upload = finiteOrZero(flow.upload);
  const download = finiteOrZero(flow.download);
  const used = upload + download;
  const remain = Number.isFinite(total) && total > 0 ? Math.max(0, total - used) : NaN;
  const usedRatio = Number.isFinite(total) && total > 0 ? clamp(used / total, 0, 1) : NaN;
  const remainRatio = Number.isFinite(usedRatio) ? 1 - usedRatio : NaN;

  return {
    name: String(sub.name || '订阅'),
    planName: flow.planName || '',
    total,
    upload,
    download,
    used,
    remain,
    usedRatio,
    remainRatio,
    remainingDays: num(flow.remainingDays),
    resetAt: calcResetAt(sub.url || '', flow.remainingDays, sub.name, cfg),
    expireAt: Number.isFinite(flow.expires) && flow.expires > 0 ? new Date(flow.expires * 1000) : null,
    appUrl: flow.appUrl || '',
  };
}

function normalizeFlow(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const usage = data.usage && typeof data.usage === 'object' ? data.usage : {};
  return {
    total: num(data.total),
    upload: num(usage.upload ?? data.upload),
    download: num(usage.download ?? data.download),
    expires: num(data.expires ?? data.expire),
    remainingDays: num(data.remainingDays ?? data.reset_day),
    planName: String(data.planName || data.plan_name || ''),
    appUrl: String(data.appUrl || data.app_url || ''),
  };
}

function hasUsableFlow(flow) {
  return flow && Number.isFinite(flow.total) && flow.total > 0 && Number.isFinite(flow.upload) && Number.isFinite(flow.download);
}

function parseFlowHeaders(headers) {
  if (!headers) return {};
  const subInfo = getHeaderValue(headers, 'subscription-userinfo');
  const appUrl = getHeaderValue(headers, 'profile-web-page-url');
  const planName = getHeaderValue(headers, 'plan-name');
  const flow = parseFlowString(subInfo);
  if (appUrl) flow.appUrl = appUrl;
  if (planName) flow.planName = planName;
  return flow;
}

function parseFlowString(raw) {
  const s = String(raw || '');
  const field = (key) => {
    const m = s.match(new RegExp(key + '=([-+]?)([0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)'));
    return m ? Number(m[1] + m[2]) : NaN;
  };
  const strField = (key) => {
    const m = s.match(new RegExp(key + '=(.*?)\\s*?(;|$)'));
    if (!m) return '';
    return safeDecode(m[1]);
  };
  return normalizeFlow({
    upload: field('upload'),
    download: field('download'),
    total: field('total'),
    expire: field('expire'),
    reset_day: field('reset_day'),
    app_url: strField('app_url'),
    plan_name: strField('plan_name'),
  });
}

function renderWidget(cfg, payload, stale, staleMsg) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const fam = cfg.family;

  if (fam === 'accessoryInline') {
    return {
      type: 'widget',
      refreshAfter: refreshISO(cfg.refreshMinutes),
      url: cfg.openUrl,
      children: [renderInline(cfg, items[0], stale)],
    };
  }

  if (fam === 'accessoryCircular') {
    return root(cfg, [renderCircular(items[0], stale, cfg)], stale);
  }

  if (fam === 'accessoryRectangular') {
    return root(cfg, [renderAccessoryRectangular(cfg, items[0], stale)], stale);
  }

  const limit = fam === 'systemLarge' || fam === 'systemExtraLarge' ? 6 : fam === 'systemSmall' ? 1 : 3;
  const shown = items.slice(0, limit);
  const children = [header(cfg, payload, stale)];

  if (shown.length > 1) {
    const summary = aggregate(shown);
    if (summary) children.push(summaryCard(summary));
  }

  if (fam === 'systemSmall') {
    children.push(renderSmallCard(shown[0]));
  } else {
    const large = fam === 'systemLarge' || fam === 'systemExtraLarge';
    for (const item of shown) children.push(renderCard(item, large));
  }

  children.push(footer(cfg, payload, stale, staleMsg));
  return root(cfg, children, stale);
}

function root(cfg, children, stale) {
  return {
    type: 'widget',
    url: cfg.openUrl,
    refreshAfter: refreshISO(cfg.refreshMinutes),
    padding: 14,
    gap: 8,
    backgroundGradient: {
      type: 'linear',
      colors: stale ? ['#2b1b0f', '#1f2937'] : ['#0f172a', '#111827', '#1e293b'],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    children,
  };
}

function header(cfg, payload, stale) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 6,
    children: [
      {
        type: 'image',
        src: stale ? 'sf-symbol:exclamationmark.triangle.fill' : 'sf-symbol:chart.bar.xaxis',
        color: stale ? '#F59E0B' : '#60A5FA',
        width: 16,
        height: 16,
      },
      text(stale ? cfg.title + ' · 缓存' : cfg.title, 'caption1', 'semibold', '#E5E7EB', { maxLines: 1, minScale: 0.6 }),
      { type: 'spacer' },
      text(fmtClock(payload.at || Date.now()), 'caption2', 'regular', '#94A3B8', { maxLines: 1 }),
    ],
  };
}

function summaryCard(summary) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 8,
    padding: [8, 10],
    backgroundColor: '#0EA5E920',
    borderRadius: 12,
    children: [
      { type: 'image', src: 'sf-symbol:sum', color: '#BAE6FD', width: 16, height: 16 },
      text('合计剩余', 'caption1', 'semibold', '#E0F2FE'),
      { type: 'spacer' },
      text(summary.text, 'headline', 'bold', summary.color, { maxLines: 1, minScale: 0.7 }),
    ],
  };
}

function renderCard(item, large) {
  if (!item) {
    return missingCard('未选择订阅');
  }
  if (item.error) {
    return errorCard(item.name || '订阅', item.error);
  }

  return {
    type: 'stack',
    direction: 'column',
    gap: 6,
    padding: [9, 10],
    backgroundColor: '#FFFFFF12',
    borderRadius: 12,
    children: [
      text(displayName(item), large ? 'headline' : 'subheadline', 'semibold', '#FFFFFF', {
        maxLines: 1,
        minScale: 0.6,
      }),
      text(remainText(item), large ? 'title2' : 'title3', 'bold', colorForRemain(item.remainRatio), {
        maxLines: 1,
        minScale: 0.6,
        textAlign: 'center',
      }),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          progressBar(item.remainRatio, true),
          text(ratioText(item.remainRatio), large ? 'caption1' : 'caption2', 'semibold', '#CBD5E1', { maxLines: 1 }),
        ],
      },
      text('总流量 ' + totalText(item) + '  ·  已用 ' + formatBytes(item.used), large ? 'caption1' : 'footnote', 'regular', '#CBD5E1', {
        maxLines: 1,
        minScale: 0.55,
      }),
      text('重置 ' + resetText(item) + '  ·  到期 ' + expireText(item), large ? 'caption1' : 'footnote', 'regular', '#CBD5E1', {
        maxLines: 1,
        minScale: 0.55,
      }),
      item.planName && item.planName !== item.name
        ? text(item.planName, large ? 'caption1' : 'caption2', 'regular', '#94A3B8', { maxLines: 1, minScale: 0.55 })
        : { type: 'spacer', length: 0 },
    ],
  };
}

function renderSmallCard(item) {
  if (!item) return missingCard('未选择订阅');
  if (item.error) return errorCard(item.name || '订阅', item.error);
  return {
    type: 'stack',
    direction: 'column',
    gap: 6,
    padding: [8, 10],
    backgroundColor: '#FFFFFF12',
    borderRadius: 12,
    children: [
      text(displayName(item), 'subheadline', 'semibold', '#FFFFFF', { maxLines: 1, minScale: 0.6 }),
      text(remainText(item), 'title3', 'bold', colorForRemain(item.remainRatio), {
        maxLines: 1,
        minScale: 0.6,
        textAlign: 'center',
      }),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          progressBar(item.remainRatio, true),
          text(ratioText(item.remainRatio), 'caption2', 'semibold', '#CBD5E1', { maxLines: 1 }),
        ],
      },
      text('重置 ' + resetText(item) + '  ·  到期 ' + expireText(item), 'footnote', 'semibold', '#E5E7EB', { maxLines: 1, minScale: 0.55 }),
    ],
  };
}

function renderInline(cfg, item, stale) {
  if (!item) return text('未选择订阅', 'caption1', 'semibold', '#FFFFFF', { maxLines: 1, minScale: 0.5 });
  if (item.error) return text(displayName(item) + ' · ' + item.error, 'caption1', 'semibold', '#FCA5A5', { maxLines: 1, minScale: 0.5 });
  const body = displayName(item) + ' 剩余 ' + remainText(item) + ' · 重置 ' + resetShort(item) + ' · 到期 ' + expireShort(item);
  return text(body, 'caption1', 'semibold', stale ? '#FDE68A' : '#FFFFFF', { maxLines: 1, minScale: 0.45 });
}

function renderCircular(item, stale, cfg) {
  const pct = Number.isFinite(item && item.remainRatio) ? Math.round(item.remainRatio * 100) + '%' : '--';
  return {
    type: 'widget',
    url: cfg.openUrl,
    refreshAfter: refreshISO(cfg.refreshMinutes),
    padding: 4,
    gap: 2,
    backgroundColor: 'rgba(0,0,0,0)',
    children: [
      { type: 'image', src: 'sf-symbol:chart.pie.fill', color: stale ? '#F59E0B' : colorForRemain(item && item.remainRatio), width: 18, height: 18 },
      text(pct, 'headline', 'bold', '#FFFFFF', { textAlign: 'center', maxLines: 1, minScale: 0.6 }),
    ],
  };
}

function renderAccessoryRectangular(cfg, item, stale) {
  if (!item) return missingCard('未选择订阅');
  if (item.error) return errorCard(item.name || '订阅', item.error);
  return {
    type: 'stack',
    direction: 'column',
    gap: 2,
    padding: 8,
    backgroundColor: '#FFFFFF10',
    borderRadius: 12,
    children: [
      text(displayName(item), 'caption1', 'semibold', '#FFFFFF', { maxLines: 1, minScale: 0.55 }),
      text(remainText(item), 'headline', 'bold', colorForRemain(item.remainRatio), { maxLines: 1, minScale: 0.6 }),
      text('重置 ' + resetShort(item) + ' · 到期 ' + expireShort(item), 'caption2', 'regular', '#CBD5E1', {
        maxLines: 1,
        minScale: 0.5,
      }),
    ],
  };
}

function footer(cfg, payload, stale, staleMsg) {
  const source = payload.source || cfg.baseUrl;
  const msg = stale ? '缓存模式 · ' + (staleMsg || '最新请求失败') : '数据源 ' + source;
  return text(msg, 'caption2', 'regular', stale ? '#FDE68A' : '#94A3B8', {
    maxLines: 1,
    minScale: 0.55,
  });
}

function errorWidget(cfg, title, msg) {
  return {
    type: 'widget',
    url: cfg.openUrl,
    refreshAfter: refreshISO(cfg.refreshMinutes),
    padding: 14,
    gap: 8,
    backgroundGradient: {
      type: 'linear',
      colors: ['#3f1d1d', '#1f2937'],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', color: '#FCA5A5', width: 16, height: 16 },
          text(title, 'headline', 'bold', '#FFFFFF', { maxLines: 1 }),
        ],
      },
      text(msg, 'caption1', 'regular', '#FCA5A5', { maxLines: 5, minScale: 0.65 }),
    ],
  };
}

function missingCard(msg) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 4,
    padding: [8, 10],
    backgroundColor: '#FFFFFF12',
    borderRadius: 12,
    children: [
      text('提示', 'caption1', 'semibold', '#FFFFFF', { maxLines: 1 }),
      text(msg, 'caption2', 'regular', '#CBD5E1', { maxLines: 2, minScale: 0.65 }),
    ],
  };
}

function errorCard(title, msg) {
  return {
    type: 'stack',
    direction: 'column',
    gap: 4,
    padding: [8, 10],
    backgroundColor: '#7F1D1D55',
    borderRadius: 12,
    children: [
      text(title, 'caption1', 'semibold', '#FFFFFF', { maxLines: 1 }),
      text(msg, 'caption2', 'regular', '#FCA5A5', { maxLines: 2, minScale: 0.65 }),
    ],
  };
}

function progressBar(remainRatio, fill) {
  if (!Number.isFinite(remainRatio)) {
    return {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        { type: 'image', src: 'sf-symbol:infinity', color: '#34D399', width: 12, height: 12 },
        text('无限流量', 'caption2', 'semibold', '#34D399', { maxLines: 1 }),
      ],
    };
  }
  const pct = clamp(remainRatio, 0, 1);
  const barStyle = fill ? { flex: 1 } : { width: 180 };
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    height: 10,
    backgroundColor: '#FFFFFF20',
    borderRadius: 5,
    ...barStyle,
    children: [
      {
        type: 'stack',
        height: 10,
        backgroundColor: colorForRemain(remainRatio),
        borderRadius: 5,
        width: fill ? undefined : Math.max(4, Math.round(180 * pct)),
        flex: fill ? pct : undefined,
        children: [{ type: 'spacer' }],
      },
      { type: 'spacer' },
    ],
  };
}

function aggregate(items) {
  const finite = items.filter((i) => i && Number.isFinite(i.total) && i.total > 0 && Number.isFinite(i.remain));
  if (!finite.length) return null;
  const remain = finite.reduce((sum, i) => sum + i.remain, 0);
  const total = finite.reduce((sum, i) => sum + i.total, 0);
  const ratio = total > 0 ? remain / total : NaN;
  return {
    text: remainText({ remain, total }),
    color: colorForRemain(ratio),
  };
}

function remainText(item) {
  if (!item) return '--';
  if (!Number.isFinite(item.total) || item.total <= 0) return '无限流量';
  return '剩余 ' + formatBytes(item.remain);
}

function totalText(item) {
  if (!item || !Number.isFinite(item.total) || item.total <= 0) return '无限';
  return formatBytes(item.total);
}

function ratioText(remainRatio) {
  if (!Number.isFinite(remainRatio)) return '无限';
  return Math.round(clamp(remainRatio, 0, 1) * 100) + '%';
}

function displayName(item) {
  if (!item) return '订阅';
  if (item.planName && item.planName !== item.name) return item.planName + ' · ' + item.name;
  return item.planName || item.name || '订阅';
}

function resetText(item) {
  if (!item) return '未知';
  if (item.resetAt instanceof Date && !isNaN(item.resetAt.getTime())) {
    return fmtDate(item.resetAt) + ' · ' + humanDuration(item.resetAt.getTime() - Date.now());
  }
  if (Number.isFinite(item.remainingDays)) {
    const d = Math.max(0, Math.floor(item.remainingDays));
    return (d === 0 ? '今天' : d + '天后');
  }
  return '未知';
}

function resetShort(item) {
  if (!item) return '未知';
  if (item.resetAt instanceof Date && !isNaN(item.resetAt.getTime())) return fmtMD(item.resetAt);
  if (Number.isFinite(item.remainingDays)) return Math.max(0, Math.floor(item.remainingDays)) + '天';
  return '未知';
}

function expireText(item) {
  if (!item || !(item.expireAt instanceof Date) || isNaN(item.expireAt.getTime())) return '长期有效';
  return fmtDate(item.expireAt) + ' · ' + humanDuration(item.expireAt.getTime() - Date.now());
}

function expireShort(item) {
  if (!item || !(item.expireAt instanceof Date) || isNaN(item.expireAt.getTime())) return '长期有效';
  return fmtMD(item.expireAt);
}

function colorForRemain(remainRatio) {
  if (!Number.isFinite(remainRatio)) return '#34D399';
  if (remainRatio <= 0.3) return '#F87171';
  if (remainRatio <= 0.5) return '#FBBF24';
  return '#34D399';
}

function calcResetAt(rawUrl, remainingDays, subName, cfg) {
  const args = parseArgs(rawUrl);
  const now = new Date();
  const envRule = getResetRule(subName, cfg);
  Object.assign(args, envRule);

  if (args.startDate && args.cycleDays) {
    const cycle = parseInt(args.cycleDays, 10);
    const start = new Date(args.startDate);
    if (Number.isFinite(cycle) && cycle > 0 && !isNaN(start.getTime())) {
      const today = startOfDay(now);
      let next = startOfDay(start);
      while (next <= today) next = addDays(next, cycle);
      return next;
    }
  }

  if (args.resetDay) {
    const day = clampInt(args.resetDay, 1, 1, 31);
    if (Number.isFinite(day)) {
      const y = now.getFullYear();
      const m = now.getMonth();
      const thisDay = Math.min(day, daysInMonth(y, m));
      if (now.getDate() <= thisDay) return new Date(y, m, thisDay, 0, 0, 0, 0);
      const nextMonth = new Date(y, m + 1, 1, 0, 0, 0, 0);
      nextMonth.setDate(Math.min(day, daysInMonth(nextMonth.getFullYear(), nextMonth.getMonth())));
      return nextMonth;
    }
  }

  if (Number.isFinite(remainingDays)) {
    return addDays(startOfDay(now), Math.max(0, Math.floor(remainingDays)));
  }

  return null;
}

function getResetRule(subName, cfg) {
  const rules = (cfg && cfg.resetRules) || {};
  const name = String(subName || '');
  if (rules[name]) return rules[name];
  const fallback = {};
  if (cfg && cfg.resetDay) fallback.resetDay = cfg.resetDay;
  if (cfg && cfg.startDate) fallback.startDate = cfg.startDate;
  if (cfg && cfg.cycleDays) fallback.cycleDays = cfg.cycleDays;
  return fallback;
}

function parseArgs(rawUrl) {
  const url = String(rawUrl || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const idx = url.indexOf('#');
  if (idx < 0) return {};
  const frag = url.slice(idx + 1).trim();
  if (!frag) return {};

  try {
    const obj = JSON.parse(safeDecode(frag));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) {}

  const out = {};
  for (const part of frag.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const val = eq < 0 ? '' : part.slice(eq + 1);
    out[key] = val === '' ? true : safeDecode(val);
  }
  return out;
}

function requestJson(ctx, url, cfg) {
  return ctx.http
    .get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Egern-SubStore-Widget',
      },
      timeout: cfg.timeout,
      redirect: 'follow',
      insecureTls: cfg.insecureTls,
    })
    .then(async (resp) => {
      const text = await safeText(resp);
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error('HTTP ' + resp.status + ' ' + preview(text, 120));
      }
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error('JSON 解析失败 ' + preview(text, 120));
      }
    });
}

function unwrapData(json) {
  if (json && typeof json === 'object' && 'data' in json) return json.data;
  return json;
}

async function safeText(resp) {
  try {
    return await resp.text();
  } catch (_) {
    return '';
  }
}

function apiUrl(base, path) {
  const b = normalizeBaseUrl(base);
  const p = String(path || '').startsWith('/') ? String(path || '') : '/' + String(path || '');
  if (/\/api$/i.test(b) && p.startsWith('/api/')) return b + p.slice(4);
  return b + p;
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function unique(arr) {
  const out = [];
  for (const item of arr) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function firstHttpUrl(raw) {
  const lines = String(raw || '').split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  return lines.find((s) => /^https?:\/\//i.test(s)) || '';
}

function splitUrlArgs(raw) {
  const s = String(raw || '');
  const idx = s.indexOf('#');
  if (idx < 0) return { url: s, args: {} };
  return { url: s.slice(0, idx), args: parseArgs(s) };
}

function parseHeaderObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const obj = JSON.parse(String(raw));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

function getHeaderValue(headers, name) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return headers.get(name) || '';
  } catch (_) {}
  const lower = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return Array.isArray(v) ? v.join(', ') : String(v || '');
    }
  }
  return '';
}

function parseList(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(v || '').trim();
  if (!s) return [];
  if (s[0] === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).map((x) => x.trim()).filter(Boolean);
    } catch (_) {}
  }
  return s.split(/[\n,|]+/).map((x) => x.trim()).filter(Boolean);
}

function readStoredSubscriptions(ctx) {
  const storage = ctx && ctx.storage;
  if (!storage) return [];

  const candidates = [];
  const keys = [
    'subs',
    'sub-store',
    'Sub-Store',
    'substore',
    'SubStore',
    'subscriptions',
  ];

  for (const key of keys) {
    try {
      if (typeof storage.getJSON === 'function') candidates.push(storage.getJSON(key));
    } catch (_) {}
    try {
      if (typeof storage.get === 'function') candidates.push(parseMaybeJSON(storage.get(key)));
    } catch (_) {}
  }

  for (const value of candidates) {
    const subs = extractSubsFromValue(value);
    if (subs.length) return subs;
  }
  return [];
}

function readStoredFlow(ctx, name) {
  const storage = ctx && ctx.storage;
  if (!storage) return null;
  const keys = [
    'flow:' + name,
    'flow_' + name,
    'sub-flow:' + name,
    'sub_flow_' + name,
    'substore-flow:' + name,
    'substore_flow_' + name,
  ];
  for (const key of keys) {
    try {
      if (typeof storage.getJSON === 'function') {
        const flow = normalizeFlow(storage.getJSON(key));
        if (hasUsableFlow(flow)) return flow;
      }
    } catch (_) {}
    try {
      if (typeof storage.get === 'function') {
        const flow = normalizeFlow(parseMaybeJSON(storage.get(key)));
        if (hasUsableFlow(flow)) return flow;
      }
    } catch (_) {}
  }
  return null;
}

function parseMaybeJSON(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function extractSubsFromValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    const arr = value.filter((item) => item && typeof item === 'object' && item.name);
    if (arr.length) return arr.map((item) => ({ ...item, source: item.source || 'storage' }));
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.subs)) return extractSubsFromValue(value.subs);
    if (value.data) return extractSubsFromValue(value.data);
    if (value.cache) return extractSubsFromValue(value.cache);
    if (value['sub-store']) return extractSubsFromValue(value['sub-store']);
    const vals = Object.values(value);
    const arr = vals.filter((item) => item && typeof item === 'object' && item.name && (item.url || item.content || item.subUserinfo));
    if (arr.length) return arr.map((item) => ({ ...item, source: item.source || 'storage' }));
  }
  return [];
}

function parseResetRules(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {}
  const rules = {};
  for (const item of s.split(/[\n|]+/)) {
    const line = item.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const conf = line.slice(idx + 1).trim();
    const rule = {};
    for (const part of conf.split(/[,&]+/)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      rule[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    if (name && Object.keys(rule).length) rules[name] = rule;
  }
  return rules;
}

function bool(v, def) {
  if (v == null || v === '') return !!def;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'y'].includes(s);
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  const x = Number.isFinite(n) ? n : def;
  return Math.min(max, Math.max(min, x));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function finiteOrZero(v) {
  return Number.isFinite(v) ? v : 0;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, days) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function refreshISO(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

function fmtMD(d) {
  return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
}

function fmtDate(d) {
  return fmtMD(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtClock(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function humanDuration(ms) {
  if (!Number.isFinite(ms)) return '未知';
  if (ms <= 0) return '已到期';
  let total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  total %= 86400;
  const hours = Math.floor(total / 3600);
  total %= 3600;
  const minutes = Math.floor(total / 60);
  if (days > 0) return days + '天' + (hours > 0 ? hours + '小时' : '');
  if (hours > 0) return hours + '小时' + (minutes > 0 ? minutes + '分钟' : '');
  return minutes + '分钟';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知';
  if (bytes < 0) bytes = 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let u = 0;
  while (bytes >= 1024 && u < units.length - 1) {
    bytes /= 1024;
    u += 1;
  }
  const digits = bytes >= 100 ? 0 : bytes >= 10 ? 1 : 2;
  return bytes.toFixed(digits) + ' ' + units[u];
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, '%20'));
  } catch (_) {
    return String(s);
  }
}

function shortError(err) {
  const msg = err && err.message ? err.message : String(err || '未知错误');
  if (/JSON 解析失败/.test(msg)) return '不是 Sub-Store API：请检查 SUB_STORE_BASE_URL 或启用 Sub-Store 模块';
  if (/HTTP 401/.test(msg) || /HTTP 403/.test(msg)) return '接口拒绝访问';
  if (/HTTP 404/.test(msg)) return '接口不存在';
  if (/timeout|timed out/i.test(msg)) return '请求超时';
  return preview(msg, 80);
}

function preview(s, len) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!len) len = 80;
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

function text(value, size, weight, color, extra) {
  const node = {
    type: 'text',
    text: value == null ? '' : String(value),
    font: { size: size || 'body', weight: weight || 'regular' },
    textColor: color || '#FFFFFF',
    maxLines: extra && extra.maxLines != null ? extra.maxLines : 1,
    minScale: extra && extra.minScale != null ? extra.minScale : 0.7,
  };
  if (extra && extra.textAlign) node.textAlign = extra.textAlign;
  if (extra && extra.flex != null) node.flex = extra.flex;
  return node;
}

function writeCache(ctx, cfg, payload) {
  if (!cfg.useCache || !ctx.storage || !ctx.storage.setJSON) return;
  try {
    ctx.storage.setJSON(cfg.cacheKey, payload);
  } catch (_) {}
}

function readCache(ctx, cfg) {
  if (!cfg.useCache || !ctx.storage || !ctx.storage.getJSON) return null;
  try {
    return ctx.storage.getJSON(cfg.cacheKey);
  } catch (_) {
    return null;
  }
}
