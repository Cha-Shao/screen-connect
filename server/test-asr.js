// ASR 端到端冒烟测试（需服务器以 mock 模式 + SC_CONFIG 测试配置启动）
// 启动方式示例：
//   $env:PORT=8099; $env:SC_CONFIG='X:\screen-connect\server\test-asr-config.yaml'; node server.js
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.ASR_TEST_PORT || 8099;
const LOG_DIR = path.join(__dirname, 'test-logs');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 生成一段 16k Int16 PCM（正弦波模拟语音 / 静音） */
function pcmChunk(sec, amp) {
  const n = Math.floor(sec * 16000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / 16000) * 32767 * amp;
    buf.writeInt16LE(v | 0, i * 2);
  }
  return buf;
}
function audioFrame(room, pcm) {
  const header = Buffer.from(JSON.stringify({ type: 'asr-audio', room }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, pcm]);
}

async function main() {
  // 清理测试日志目录
  if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });

  const alice = new WebSocket(`ws://localhost:${PORT}/ws`);
  const aliceMsgs = [];
  alice.on('message', (d) => {
    // 注意：ws 库文本帧也可能以 Buffer 到达，直接尝试 JSON.parse（二进制音频帧会解析失败被忽略）
    try { aliceMsgs.push(JSON.parse(d)); } catch (e) {}
  });
  await new Promise((r) => alice.on('open', r));

  // 1. 房间列表带 asr 标志
  alice.send(JSON.stringify({ type: 'get-rooms' }));
  await wait(200);
  const roomList = aliceMsgs.find((m) => m.type === 'room-list');
  console.log('[1] room-list:', roomList && roomList.rooms.length, '个房间, 首个 asr=', roomList && roomList.rooms[0].asr);

  // 2. 加入房间
  alice.send(JSON.stringify({ type: 'join', room: '大厅', id: 'A001', nickname: 'Alice' }));
  await wait(200);
  console.log('[2] joined:', !!aliceMsgs.find((m) => m.type === 'joined'));

  // 3. 开启 ASR
  alice.send(JSON.stringify({ type: 'asr-toggle', on: true }));
  await wait(300);
  const stateOn = aliceMsgs.find((m) => m.type === 'asr-state' && m.on);
  const badgeOn = aliceMsgs.find((m) => m.type === 'asr-badge' && m.on && m.roomId === '大厅');
  console.log('[3] asr-state on:', !!stateOn, '| asr-badge on:', !!badgeOn);

  // 4. 发送 4 秒"语音" + 静音触发切句
  for (let i = 0; i < 8; i++) alice.send(audioFrame('大厅', pcmChunk(0.5, 0.4)));
  alice.send(audioFrame('大厅', pcmChunk(1.5, 0)));
  await wait(2500);
  const line = aliceMsgs.find((m) => m.type === 'asr-line');
  console.log('[4] asr-line:', line ? `${line.nickname}：${line.text} @${new Date(line.t).toTimeString().slice(0, 5)}` : 'NONE');

  // 5. 中途加入的 Bob 应收到历史
  const bob = new WebSocket(`ws://localhost:${PORT}/ws`);
  const bobMsgs = [];
  bob.on('message', (d) => {
    try { bobMsgs.push(JSON.parse(d)); } catch (e) {}
  });
  await new Promise((r) => bob.on('open', r));
  bob.send(JSON.stringify({ type: 'join', room: '大厅', id: 'B002', nickname: 'Bob' }));
  await wait(300);
  const bobHistory = bobMsgs.find((m) => m.type === 'asr-history');
  console.log('[5] Bob 收到 asr-history lines:', bobHistory ? bobHistory.lines.length : 'NONE');

  // 6. 关闭 ASR → 落盘
  alice.send(JSON.stringify({ type: 'asr-toggle', on: false }));
  await wait(400);
  const stateOff = aliceMsgs.find((m) => m.type === 'asr-state' && !m.on);
  console.log('[6] asr-state off, file:', stateOff && stateOff.file);

  // 7. 检查落盘文件
  let files = [];
  if (fs.existsSync(LOG_DIR)) files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.txt'));
  console.log('[7] 落盘文件:', files);
  if (files.length) {
    const content = fs.readFileSync(path.join(LOG_DIR, files[0]), 'utf8');
    console.log('    ---- 文件内容 ----');
    console.log(content.split('\n').map((l) => '    | ' + l).join('\n'));
  }

  alice.close(); bob.close();
  const ok = !!stateOn && !!badgeOn && !!line && !!stateOff && !!bobHistory && files.length === 1;
  console.log(ok ? '=== ASR TEST PASSED ===' : '=== ASR TEST FAILED ===');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
