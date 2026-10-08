// Passive recon — chỉ fetch tài nguyên public trong scope (doc §4: quét thụ động).
// Map API endpoints từ bundle JS của frontend + thư mục livestream + response /api.
const { scopedFetch } = require('./http');
const { getSite } = require('../sites');

// Regex bắt API path trong bundle minified: "/account/me", api+"/x", `livestreams/${…}`…
const PATH_RE = /["'`](\/(api\/)?[a-z0-9_\-\/]+(\$\{[^}]*\}[a-z0-9_\-\/]*)*)["'`]/gi;
const NOISE_RE = /\.(png|jpe?g|svg|webp|css|woff2?|ttf|mp4|webm|ico|gif|map)$|^(https?:)?\/\//i;

async function fetchText(url, tag) {
  const res = await scopedFetch(url, { auditTag: tag, timeoutMs: 20000 });
  return { status: res.status, text: await res.text(), finalUrl: res.url };
}

async function reconSite(siteId) {
  const site = getSite(siteId);
  const tag = `recon:${siteId}`;
  const out = {
    siteId: site.id, origin: site.origin, apiBase: site.apiBase,
    pages: [], scriptUrls: [], apiPaths: new Set(), endpointsSample: [],
    notes: []
  };

  // 1) Trang chủ + trang live mặc định → lấy script bundle URLs
  const pageUrls = [site.origin + '/', site.defaultLiveUrl];
  for (const p of pageUrls) {
    try {
      const { status, text, finalUrl } = await fetchText(p, tag);
      out.pages.push({ url: p, status, finalUrl });
      for (const m of text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
        const src = new URL(m[1], finalUrl).toString();
        out.scriptUrls.push(src);
      }
    } catch (e) {
      out.pages.push({ url: p, error: e.message });
    }
  }

  // 2) Fetch từng bundle (scopedFetch vẫn giới hạn 2 rps/host), gom API paths
  const bundles = [...new Set(out.scriptUrls)].filter(u => /\.(js|mjs)(\?|$)/i.test(u)).slice(0, 12);
  for (const b of bundles) {
    try {
      const { text } = await fetchText(b, tag);
      for (const m of text.matchAll(PATH_RE)) {
        const p = m[1];
        if (p.length < 3 || p.length > 120 || NOISE_RE.test(p)) continue;
        if (!/[a-z]/i.test(p)) continue;
        out.apiPaths.add(p);
      }
      // Lấy luôn URL absolute tới api host nếu bundle hard-code
      for (const m of text.matchAll(/https?:\/\/[a-z0-9.\-]+/gi)) out.apiPaths.add(m[0]);
    } catch (e) {
      out.notes.push(`bundle lỗi ${b}: ${e.message}`);
    }
  }

  // 3) Endpoint đã biết (không auth) để map response shape
  for (const p of ['/livestreams']) {
    const url = site.apiBase + p;
    try {
      const res = await scopedFetch(url, { auditTag: tag });
      const body = (await res.text()).slice(0, 500);
      out.endpointsSample.push({ url, status: res.status, body });
    } catch (e) {
      out.endpointsSample.push({ url, error: e.message });
    }
  }

  out.apiPaths = [...out.apiPaths].sort();
  out.scriptCount = out.scriptUrls.length;
  return out;
}

async function reconAll() {
  const { SITES } = require('../sites');
  const results = {};
  // Tuần tự: mỗi site vẫn chịu limit riêng, nhưng giữ đơn giản + audit dễ đọc
  for (const id of Object.keys(SITES)) {
    results[id] = await reconSite(id).catch(e => ({ siteId: id, error: e.message }));
  }
  return results;
}

module.exports = { reconSite, reconAll };
