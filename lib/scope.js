// Scope guard cho chương trình bug bounty (BBP-2026-001).
// Single source of truth: host in-scope lấy từ lib/sites.js — chỉnh scope = sửa sites.js.
// Mọi request của bounty engine PHẢI đi qua lib/bounty/http.js (scopedFetch) để được enforce.
const { SITES } = require('./sites');

const ALLOWED_PORTS = new Set(['', '80', '443']); // doc §4: không scan port ngoài 80/443
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

// Host in-scope = frontend origin + apiBase của từng site. Exact match only:
// subdomain/mirror không liệt kê tại doc §2 là out-of-scope (doc §3).
const scopeHosts = new Set();
const scopeTargets = []; // { host, siteId, kind: 'frontend'|'api' }
for (const site of Object.values(SITES)) {
  for (const host of site.hosts) {
    const h = host.toLowerCase();
    if (!scopeHosts.has(h)) scopeTargets.push({ host: h, siteId: site.id, kind: 'frontend' });
    scopeHosts.add(h);
  }
  const apiHost = new URL(site.apiBase).hostname.toLowerCase();
  if (!scopeHosts.has(apiHost)) scopeTargets.push({ host: apiHost, siteId: site.id, kind: 'api' });
  scopeHosts.add(apiHost);
  // Host first-party bổ sung từ recon (WS hub, frontend phụ) — doc §2 WebSocket/SignalR
  for (const host of (site.extraScopeHosts || [])) {
    const h = host.toLowerCase();
    if (!scopeHosts.has(h)) scopeTargets.push({ host: h, siteId: site.id, kind: 'extra' });
    scopeHosts.add(h);
  }
}
function isInScope(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch (e) {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return false;
  if (!ALLOWED_PORTS.has(u.port)) return false;
  return scopeHosts.has(u.hostname.toLowerCase());
}

// Trả về siteId mà URL này thuộc về (ưu tiên apiBase, rồi frontend), hoặc null nếu OOS.
function siteOf(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch (e) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const t = scopeTargets.find(t => t.host === host && t.kind === 'api')
        || scopeTargets.find(t => t.host === host);
  return t ? t.siteId : null;
}

function listScope() {
  return Object.values(SITES).map(s => ({
    siteId: s.id,
    name: s.name,
    frontends: s.hosts.map(h => `https://${h}`),
    apiBase: s.apiBase
  }));
}

module.exports = { isInScope, siteOf, listScope, scopeHosts };
