// Silero VAD 人声门控单测：
//   真实人声样本（16kHz wav）-> isSpeech === true
//   白噪声（鼓掌/环境音）  -> isSpeech === false
//   静音                    -> isSpeech === false
// 依赖（可选）：server/silero/silero_vad.onnx + onnxruntime-node
//   bash setup-silero-vad.sh
// 缺依赖时打印 SKIP 并退出 0（不影响其他测试）。
// 人声样本可用环境变量 SILERO_TEST_WAV 指定本地文件或 URL。
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { SileroVadGate } = require('./asr');

const MODEL = path.join(__dirname, 'silero', 'silero_vad.onnx');
const DEFAULT_SAMPLE_URLS = [
  process.env.SILERO_TEST_WAV,
  'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/hello_world_female2.wav',
  'https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav',
].filter(Boolean);

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getBuffer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return getBuffer(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/** 解析 WAV（支持任意块布局），返回 { sampleRate, pcm: Int16Array } */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV');
  const sampleRate = buf.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(off + 8 + i * 2);
      return { sampleRate, pcm };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV 里没有 data 块');
}

function noisePcm(sec, amp) {
  const n = Math.floor(sec * 16000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = (Math.random() * 2 - 1) * 32767 * amp;
  return pcm;
}

async function main() {
  if (!fs.existsSync(MODEL)) {
    console.log('SKIP: 缺少 ' + MODEL + '（先跑 bash setup-silero-vad.sh / setup-silero-vad.ps1）');
    return;
  }
  try { require.resolve('onnxruntime-node'); }
  catch (e) {
    console.log('SKIP: 缺少 onnxruntime-node（cd server && npm install onnxruntime-node --no-save）');
    return;
  }

  const gate = new SileroVadGate({
    rootDir: __dirname,
    speechGate: { enabled: true, mode: 'silero', model: 'silero/silero_vad.onnx' },
  });
  if (!gate.ready) { console.log('SKIP: 门控未就绪（' + gate.modelPath + '）'); return; }

  // ---- 1) 真实人声 ----
  let speechOk = false;
  for (const url of DEFAULT_SAMPLE_URLS) {
    try {
      const buf = await getBuffer(url);
      const { sampleRate, pcm } = parseWav(buf);
      if (sampleRate !== 16000) {
        console.log('[1] 样本采样率 ' + sampleRate + ' != 16000，换下一个来源');
        continue;
      }
      const r = await gate.isSpeech(pcm);
      console.log('[1] 真实人声样本 isSpeech =', r, '(' + url + ')');
      speechOk = r === true;
      if (speechOk) break;
    } catch (e) {
      console.log('[1] 样本获取/解析失败:', e.message, '，换下一个来源');
    }
    await wait(100);
  }
  if (!speechOk && !DEFAULT_SAMPLE_URLS.length) console.log('[1] SKIP: 未提供人声样本');

  // ---- 2) 白噪声（鼓掌/环境音）----
  const r2 = await gate.isSpeech(noisePcm(2, 0.5));
  console.log('[2] 2s 白噪声 isSpeech =', r2);
  const noiseOk = r2 === false;

  // ---- 3) 静音 ----
  const r3 = await gate.isSpeech(new Int16Array(16000 * 2));
  console.log('[3] 2s 静音 isSpeech =', r3);
  const silenceOk = r3 === false;

  console.log('门控统计:', JSON.stringify(gate.stats));
  const ok = speechOk && noiseOk && silenceOk;
  console.log('=== SILERO GATE TEST ' + (ok ? 'PASSED' : 'FAILED') + ' ===');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
