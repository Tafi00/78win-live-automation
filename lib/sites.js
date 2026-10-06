// Cấu hình từng site livestream dùng chung nền tảng (API claim lì xì, điểm danh, SignalR giống nhau).
// Mỗi site chỉ khác domain, API host, sitekey Turnstile và cách trả phần thưởng.
const SITES = {
  '78win': {
    id: '78win',
    name: '78win',
    origin: 'https://78win-live.pages.dev',
    hosts: ['78win-live.pages.dev'],
    apiBase: 'https://live-78win-apiclient.attcloud.org/api',
    siteKey: '0x4AAAAAAEm2LdKEVhgZvq9H',
    defaultLiveUrl: 'https://78win-live.pages.dev/live/78winlive-idollive',
    // Claim trả kết quả (điểm) ngay trong response
    claimStatusCheck: false
  },
  qq88: {
    id: 'qq88',
    name: 'QQ88',
    origin: 'https://www.qq88live.live',
    hosts: ['www.qq88live.live', 'qq88live.live'],
    apiBase: 'https://live-qq88-client-v2.royalcloud.work/api',
    siteKey: '0x4AAAAAAEi81C0k5-Iu5OQf',
    defaultLiveUrl: 'https://www.qq88live.live/live/QQ88live-idol-live-qq88',
    // Claim chỉ xếp hàng; phần thưởng (điểm hoặc mã Code) lấy qua GET /livestreams/check-status
    claimStatusCheck: true
  },
  mb66: {
    id: 'mb66',
    name: 'MB66',
    origin: 'https://mb66-live.pages.dev',
    hosts: ['mb66-live.pages.dev'],
    apiBase: 'https://live-mb66-apiclient.attcloud.org/api',
    siteKey: '0x4AAAAAACVWHAdOOJQmHLqi',
    defaultLiveUrl: 'https://mb66-live.pages.dev/live/mb66live-idollivemb',
    // Claim trả kết quả (điểm) ngay trong response, giống 78win — bundle không có check-status
    claimStatusCheck: false
  }
};

const DEFAULT_SITE = '78win';

function getSite(id) {
  return SITES[id] || SITES[DEFAULT_SITE];
}

function siteFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const found = Object.values(SITES).find(s => s.hosts.includes(host));
    if (found) return found;
  } catch (e) {}
  return SITES[DEFAULT_SITE];
}

function listSites() {
  return Object.values(SITES).map(s => ({ id: s.id, name: s.name, defaultLiveUrl: s.defaultLiveUrl }));
}

module.exports = { SITES, DEFAULT_SITE, getSite, siteFromUrl, listSites };
