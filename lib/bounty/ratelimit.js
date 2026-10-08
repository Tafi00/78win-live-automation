// Token bucket theo host — enforce giới hạn §4 (tối đa 2 req/giây/host).
// Mặc định conservative: 2 req/s, burst 2. Không cấu hình cao hơn trong code;
// muốn nhanh hơn phải sửa RoE trước.
const DEFAULT_RPS = 2;

const buckets = new Map(); // host -> { tokens, lastRefill }

function bucketFor(host, rps) {
  let b = buckets.get(host);
  if (!b || b.rps !== rps) {
    b = { tokens: Math.min(rps, 2), lastRefill: Date.now(), rps };
    buckets.set(host, b);
  }
  return b;
}

// Chờ tới khi host có token. Trả về ms đã chờ.
async function acquire(host, rps = DEFAULT_RPS) {
  const b = bucketFor(host, rps);
  const t0 = Date.now();
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(b.rps, b.tokens + ((now - b.lastRefill) / 1000) * b.rps);
    b.lastRefill = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return now - t0;
    }
    const waitMs = Math.ceil(((1 - b.tokens) / b.rps) * 1000);
    await new Promise(r => setTimeout(r, Math.min(waitMs, 1000)));
  }
}

function stats() {
  const out = {};
  for (const [host, b] of buckets) out[host] = { rps: b.rps, tokens: +b.tokens.toFixed(2) };
  return out;
}

module.exports = { acquire, stats, DEFAULT_RPS };
