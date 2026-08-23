// 阿里云百炼引擎端到端冒烟测试（qwen-audio-3.0-asr-flash，多模态 generation 接口）
// 引擎把每句话转成 WAV 后 base64 内联（data:audio/wav;base64,...），POST 到
//   /api/v1/services/aigc/multimodal-generation/generation（同步调用，短音频直接返回文本）
// 请求体 content[0] = { type: "input_audio", input_audio: { data } }（与实测可用样例一致）
// 无语音内容（鼓掌/环境音）时百炼返回 HTTP 400 + 空响应体 {}：应静默忽略、不产行、不保存失败音频
// 用本地 HTTP stub 模拟百炼 MaaS：校验鉴权头/模型/请求体/音频 base64，返回多模态响应。
// 验证：VAD -> WAV -> base64 -> HTTP 转写 -> 解析 output.choices[0].message.content -> 广播 -> 落盘
// 启动方式（先启动应用服务器；测试配置里 asr.aliyun.baseUrl 指向 stub）：
//   $env:PORT=8099; $env:SC_CONFIG='X:\screen-connect\server\test-asr-aliyun-config.yaml'; node server.js
//   node test-asr-aliyun.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const APP_PORT = process.env.ASR_TEST_PORT || 8099;
const STUB_PORT = 8123;
const LOG_DIR = path.join(__dirname, 'test-logs-aliyun');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function pcmChunk(sec, amp, noise) {
  const n = Math.floor(sec * 16000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // noise=true：白噪声（模拟鼓掌/环境音，无语音内容）；否则 220Hz 正弦（模拟语音）
    const v = (noise ? Math.random() * 2 - 1 : Math.sin((2 * Math.PI * 220 * i) / 16000)) * 32767 * amp;
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

// ---- 百炼 MaaS 多模态 generation 接口 HTTP 桩 ----
const stubChecks = { ok: true, errors: [], posts: 0, audioOk: false, normalizedPeak: 0, noSpeech400: 0 };
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}

const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + STUB_PORT);
  const auth = req.headers.authorization || '';

  // 多模态 generation（同步转写）
  if (u.pathname === '/api/v1/services/aigc/multimodal-generation/generation' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      stubChecks.posts++;
      if (auth !== 'Bearer test-key') stubChecks.errors.push('auth=' + auth);
      if (req.headers['x-dashscope-sse'] !== 'disable') stubChecks.errors.push('缺少 X-DashScope-SSE: disable');
      let body;
      try { body = JSON.parse(raw); } catch (e) { stubChecks.errors.push('body 解析失败'); return sendJson(res, 400, { code: 'BadRequest' }); }
      if (body.model !== 'qwen-audio-3.0-asr-flash') stubChecks.errors.push('model=' + body.model);
      const content = (body.input && body.input.messages && body.input.messages[0] && body.input.messages[0].content) || [];
      const part = content[0] || {};
      if (part.type !== 'input_audio' || !part.input_audio || typeof part.input_audio.data !== 'string') {
        stubChecks.errors.push('content[0] 不是 { type: "input_audio", input_audio: { data } } 结构（' + JSON.stringify(part).slice(0, 80) + '）');
      }
      const audio = (part.input_audio && part.input_audio.data) || '';
      const m = /^data:audio\/wav;base64,(.+)$/.exec(audio);
      if (!m) {
        stubChecks.errors.push('input_audio.data 不是 data:audio/wav;base64 格式（前 60 字符: ' + String(audio).slice(0, 60) + '）');
      } else {
        try {
          const buf = Buffer.from(m[1], 'base64');
          stubChecks.audioOk = buf.length > 44 && buf.toString('utf8', 0, 4) === 'RIFF' && buf.toString('utf8', 8, 12) === 'WAVE';
          if (!stubChecks.audioOk) {
            stubChecks.errors.push('base64 解码后不是合法 WAV（len=' + buf.length + '）');
          } else {
            // 校验归一化：喂入 0.4 幅度的正弦，归一化后峰值应被放大到 0.85 满幅附近（≥ 20000）
            let peak = 0;
            for (let i = 44; i + 1 < buf.length; i += 2) {
              const a = Math.abs(buf.readInt16LE(i));
              if (a > peak) peak = a;
            }
            stubChecks.normalizedPeak = peak;
            if (peak < 20000) stubChecks.errors.push('音频峰值过低（未归一化? peak=' + peak + '）');
            // 无语音内容（鼓掌/环境音）模拟：白噪声过零率 ≈ 0.5，正弦 ≈ 0.03，> 0.1 判为噪声，
            // 此时百炼实测返回 HTTP 400 + 空响应体 {}（引擎应静默忽略、不保存音频）
            let zc = 0;
            for (let i = 44; i + 2 < buf.length; i += 2) {
              if ((buf.readInt16LE(i) >= 0) !== (buf.readInt16LE(i + 2) >= 0)) zc++;
            }
            const zcr = zc / Math.max(1, (buf.length - 44) / 2 - 1);
            if (zcr > 0.1) {
              stubChecks.noSpeech400++;
              return sendJson(res, 400, {});
            }
          }
        } catch (e) {
          stubChecks.errors.push('base64 解码失败: ' + e.message);
        }
      }
      const p = (body.parameters || {});
      if (p.format !== 'mp3' || String(p.sample_rate) !== '16000') {
        stubChecks.errors.push('parameters=' + JSON.stringify(p) + '（应为 { format: "mp3", sample_rate: "16000" }）');
      }
      // 同步返回多模态响应：output.choices[0].message.content[0].text
      sendJson(res, 200, {
        output: { choices: [{ message: { role: 'assistant', content: [{ text: '阿里云转写测试' }] } }] },
        usage: { input_tokens: 10, output_tokens: 5 },
        request_id: 'req-1',
      });
    });
    return;
  }

  sendJson(res, 404, { code: 'NotFound', message: u.pathname });
});

async function main() {
  if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
  await new Promise((r) => stub.listen(STUB_PORT, r));
  console.log('[stub] 百炼多模态 generation 桩已启动 :' + STUB_PORT);

  const alice = new WebSocket(`ws://localhost:${APP_PORT}/ws`);
  const msgs = [];
  alice.on('message', (d) => { try { msgs.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => alice.on('open', r));

  alice.send(JSON.stringify({ type: 'join', room: '大厅', id: 'A001', nickname: 'Alice' }));
  await wait(200);

  // 开启转写（引擎由 config 决定 = aliyun-bailian）
  alice.send(JSON.stringify({ type: 'asr-toggle', on: true }));
  await wait(300);
  const stateOn = msgs.find((m) => m.type === 'asr-state' && m.on);
  console.log('[1] asr-state on, mode =', stateOn && stateOn.mode);

  // 喂 4 秒"语音" + 静音触发切句
  for (let i = 0; i < 8; i++) alice.send(audioFrame('大厅', pcmChunk(0.5, 0.4)));
  alice.send(audioFrame('大厅', pcmChunk(1.5, 0)));
  await wait(4000);
  const line = msgs.find((m) => m.type === 'asr-line');
  console.log('[2] asr-line:', line ? line.nickname + '：' + line.text : 'NONE');

  // 鼓掌/环境音（无语音内容）：桩返回 400 + {}，引擎应静默忽略——不产行、不报错、不保存失败音频
  for (let i = 0; i < 4; i++) alice.send(audioFrame('大厅', pcmChunk(0.5, 0.5, true)));
  alice.send(audioFrame('大厅', pcmChunk(1.5, 0)));
  await wait(4000);
  const lineCount = msgs.filter((m) => m.type === 'asr-line').length;
  const failedDir = path.join(__dirname, 'test-audio-aliyun', 'failed');
  const failedSaved = fs.existsSync(failedDir) ? fs.readdirSync(failedDir).length : 0;
  console.log('[3] 桩收到请求数:', stubChecks.posts, '| 其中无语音 400 {} 次数:', stubChecks.noSpeech400, '| asr-line 行数:', lineCount, '| failed 目录保存数:', failedSaved);
  console.log('[4] 音频 base64 合法 WAV:', stubChecks.audioOk, '| 归一化后峰值:', stubChecks.normalizedPeak);
  console.log('[5] 桩校验错误:', stubChecks.errors.length ? stubChecks.errors : '无');

  alice.send(JSON.stringify({ type: 'asr-toggle', on: false }));
  await wait(400);
  const stateOff = msgs.find((m) => m.type === 'asr-state' && !m.on);
  console.log('[6] asr-state off, file:', stateOff && stateOff.file);

  let files = [];
  if (fs.existsSync(LOG_DIR)) files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.txt'));
  console.log('[7] 落盘文件:', files);
  if (files.length) {
    console.log('    ---- 内容 ----');
    console.log(fs.readFileSync(path.join(LOG_DIR, files[0]), 'utf8').split('\n').map((l) => '    | ' + l).join('\n'));
  }

  alice.close();
  stub.close();
  const ok = stateOn && stateOn.mode === 'aliyun-bailian'
    && line && line.text === '阿里云转写测试'
    && stubChecks.posts === 2 && stubChecks.noSpeech400 === 1
    && stubChecks.audioOk && stubChecks.errors.length === 0
    && lineCount === 1 && failedSaved === 0
    && stateOff && files.length === 1;
  console.log(ok ? '=== ALIYUN ASR TEST PASSED ===' : '=== ALIYUN ASR TEST FAILED ===');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
