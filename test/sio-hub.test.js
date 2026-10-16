// Test hub Socket.IO (QQ88): server ws giả làm đúng handshake đo thật trên live-qq-api.royalcloud.work ngày 16/10/2026.
// Chạy: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const { decode, encode } = require('@msgpack/msgpack');
const auth = require('../lib/auth');
auth.getSession = () => ({ token: 'TEST-TOKEN' });   // tracker-ws destructure lúc require: patch trước khi nạp
const { LiveTrackerWS, sioPacket, SIO } = require('../lib/tracker-ws');
const { getSite } = require('../lib/sites');

test('qq88 dùng API host mới và hub Socket.IO; 78win/mb66 vẫn SignalR', () => {
  assert.strictEqual(getSite('qq88').apiBase, 'https://live-qq-api.royalcloud.work/api');
  assert.strictEqual(getSite('qq88').hubKind, 'socketio');
  assert.strictEqual(getSite('78win').hubKind, undefined);
  assert.strictEqual(getSite('mb66').hubKind, undefined);
});

test('gói Socket.IO msgpack khớp byte với notepack.io', () => {
  assert.strictEqual(sioPacket(SIO.CONNECT, '/livestream', { token: '' }).toString('hex'),
    '83a47479706500a36e7370ab2f6c69766573747265616da46461746181a5746f6b656ea0');
  assert.strictEqual(sioPacket(SIO.EVENT, '/livestream', ['JoinGroup', 'room', 'tok', 'fp']).toString('hex'),
    '83a47479706502a36e7370ab2f6c69766573747265616da46461746194a94a6f696e47726f7570a4726f6f6da3746f6ba26670');
});

test('hub QQ88: CONNECT -> JoinGroup -> nhận RecvRewardAnnounce, pong cho ping', async () => {
  const wss = new WebSocketServer({ port: 0 });
  const port = wss.address().port;
  const seen = [];
  let pong = false;
  wss.on('connection', (ws) => {
    ws.send('0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    ws.on('message', (data, isBinary) => {
      if (!isBinary) { if (String(data) === '3') pong = true; return; }
      const pkt = decode(data);
      seen.push(pkt);
      if (pkt.type === SIO.CONNECT) {
        ws.send(Buffer.from(encode({ type: 0, data: { sid: 'ns1', pid: null }, nsp: '/livestream' })));
      } else if (pkt.type === SIO.EVENT && pkt.data[0] === 'JoinGroup') {
        ws.send(Buffer.from(encode({ type: 2, data: ['CallerJoinGroup', 'Ok'], nsp: '/livestream' })));
        ws.send('2');
        ws.send(Buffer.from(encode({ type: 2, nsp: '/livestream', data: ['RecvRewardAnnounce',
          { group: 'room-1', sessionId: '7cea37f0-16ac-4090-826e-2dea503c3c1f', requiredShareCount: 0 }] })));
      }
    });
  });
  const t = new LiveTrackerWS();
  t.isRunning = true;
  t.site = getSite('qq88');
  t.streamId = 'room-1';
  t.primaryAccount = 'nobody';
  t.config = { autoLixi: true };
  t.sioUrlOverride = `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`;
  t.ensureVisitorId = async () => { t.visitorId = 'fp-test'; };
  const claims = [];
  t.claimLixiForAllAccounts = (sessionId, group) => claims.push([sessionId, group]);
  t.connectHub();
  for (let i = 0; i < 50 && !(claims.length && pong); i++) await new Promise(r => setTimeout(r, 100));
  t.isRunning = false;
  t.wsGeneration++;
  try { t.ws.terminate(); } catch (e) {}
  clearInterval(t.wsPingTimer);
  wss.close();
  assert.deepStrictEqual(seen[0].data, { token: 'TEST-TOKEN' });
  assert.deepStrictEqual(seen[1].data, ['JoinGroup', 'room-1', 'TEST-TOKEN', 'fp-test']);
  assert.deepStrictEqual(claims, [['7cea37f0-16ac-4090-826e-2dea503c3c1f', 'room-1']]);
  assert.ok(pong, 'phải trả pong');
});
