/**
 * screen-connect 信令服务器 v2
 * - 静态托管 ../ui 前端
 * - WebSocket 信令：房间管理 + 点对点信令中继
 * - 全局用户追踪：谁连了服务器、在哪个房间，广播给所有人
 * - move-user / invite 信令
 * 部署在公网机器上，客户端连接 ws(s)://host:PORT
 */
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { WebSocketServer } = require('ws');
const asr = require('./asr');

const PORT = process.env.PORT || 1454;
const UI_DIR = path.join(__dirname, '..', 'ui');
// 生产/部署：静态托管 ui/dist（Vite 构建产物）。
// 服务器不启动、不转发 Vite —— 只负责把构建好的静态文件用 fs.readFile 直接响应。
// dist 不存在（未执行 pnpm build:ui）时返回引导页，提示先构建（React 源码不能由 Node 直接运行）。
const UI_DIST = path.join(UI_DIR, 'dist');
const FRONTEND_DIR = fs.existsSync(UI_DIST) ? UI_DIST : null;

const BUILD_HINT_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>前端未构建</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0e1116;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center;max-width:520px;padding:24px">
<h1 style="font-size:22px;margin:0 0 12px">前端未构建</h1>
<p style="line-height:1.8;color:#8b949e">信令服务器只托管 <code style="background:#1c2230;padding:2px 6px;border-radius:4px">ui/dist</code> 静态产物。<br>
请先在仓库根目录运行 <code style="background:#1c2230;padding:2px 6px;border-radius:4px">pnpm build:ui</code>，再刷新本页。</p>
<p style="line-height:1.8;color:#8b949e">开发模式（带热重载）请直接访问 Vite dev server：<br>
<code style="background:#1c2230;padding:2px 6px;border-radius:4px">pnpm dev:ui</code> → <code style="background:#1c2230;padding:2px 6px;border-radius:4px">http://localhost:5173</code></p>
</div>
</body></html>`;

// 可用环境变量 SC_CONFIG 覆盖配置文件路径（测试/多环境部署用）
const CONFIG_PATH = process.env.SC_CONFIG || path.join(__dirname, 'config.yaml');

// 读取监听地址（config.yaml 顶层 host 键）
//   host: "0.0.0.0"    -> 监听所有网卡（默认，公网直连）
//   host: "127.0.0.1"  -> 只监听本机回环（内网模式 + Nginx/Caddy 反代）
const ALLOWED_HOSTS = ['0.0.0.0', '127.0.0.1', 'localhost', '::', '::1'];
function loadHost() {
  try {
    const doc = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const host = doc && typeof doc.host === 'string' ? doc.host.trim() : '';
    if (host) {
      if (!ALLOWED_HOSTS.includes(host)) {
        console.warn(`警告: config.yaml 里 host: "${host}" 不在推荐值 ${ALLOWED_HOSTS.join('/')} 中，请确认这是你想要的监听地址`);
      }
      return host;
    }
  } catch (e) { /* 读取失败用默认值 */ }
  return '0.0.0.0';
}
const HOST = loadHost();

// 读取房间配置
function loadRooms() {
  try {
    const doc = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const rooms = (doc && Array.isArray(doc.rooms)) ? doc.rooms : [];
    return rooms.map((r) => ({
      id: String(r.id || r.name),
      name: String(r.name || r.id),
      desc: r.desc ? String(r.desc) : '',
    }));
  } catch (e) {
    console.warn('读取 config.yaml 失败，使用空列表:', e.message);
    return [];
  }
}
let ROOMS = loadRooms();
console.log(`已加载 ${ROOMS.length} 个房间:`, ROOMS.map((r) => r.name).join(', '));

// 读取 ICE 服务器配置
const DEFAULT_ICE = [
  { urls: 'stun:www.elfmc.com:3478' },
  { urls: 'turn:www.elfmc.com:3478', username: 'elfmcapp', credential: '123456' },
  { urls: 'turn:www.elfmc.com:3478?transport=tcp', username: 'elfmcapp', credential: '123456' },
];
function loadIceServers() {
  try {
    const doc = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (doc && Array.isArray(doc.iceServers) && doc.iceServers.length) return doc.iceServers;
  } catch (e) { console.warn('读取 iceServers 失败，使用默认:', e.message); }
  return DEFAULT_ICE;
}
let ICE_SERVERS = loadIceServers();
console.log(`已加载 ${ICE_SERVERS.length} 个 ICE 服务器`);

// ============================================================================
// ASR（语音转写）配置
// ============================================================================
const DEFAULT_ASR = {
  enabled: false,          // 是否启用 ASR 功能
  mode: 'local-vosk',      // 默认转写引擎：'local-whisper'（本地 whisper）| 'local-vosk'（本地 Vosk，推荐）| 'aliyun-bailian'（阿里云百炼，计费）
  mock: false,             // 模拟转写（测试用，不调用真实引擎）
  logDir: 'logs',          // 转写日志目录（相对 server/ 或绝对路径）
  vadThreshold: 0.012,     // VAD 能量阈值（RMS）
  minSpeechMs: 600,        // 最短语句长度
  silenceFlushMs: 900,     // 尾音静音多少毫秒后切句
  maxUtteranceMs: 10000,   // 语句最长时长，超时强制切句
  whisper: {               // 本地 whisper.cpp 引擎
    bin: 'whisper-cli',        // CLI 路径（相对 server/ 或绝对路径；Linux 上在 PATH 里可只写 whisper-cli）
    model: 'whisper/ggml-base.bin', // base 模型路径
    language: '',              // 语言，留空自动检测；如 'zh'、'en'
    threads: 4,                // 推理线程数
  },
  aliyun: {                // 阿里云百炼（qwen-audio-3.0-asr-flash，约 0.00022 元/秒）
    apiKey: '',            // 百炼 API Key（也可用环境变量 DASHSCOPE_API_KEY）
    workspaceId: '',       // 百炼控制台 workspace-id（请求域名里的 [workspace-id]，按地域区分）
    model: 'qwen-audio-3.0-asr-flash', // 多模态语音识别模型（multimodal-generation 接口，音频 base64 内联）
    region: 'cn-beijing',  // 地域：华北2北京 cn-beijing；华南（离广州近）可用 cn-shenzhen（需开通并换该地域 workspace-id）
    audioDir: 'asr-audio', // 转写失败时保留的音频目录（相对 server/ 或绝对路径）
    parameters: {},        // 转写参数，默认 { language_hints: ["zh","en"] }，可整体覆盖
    selfTest: false,       // 启动自检：用官方示例音频跑一遍转写，验证 Key/服务/地域（诊断用）
    baseUrl: '',           // 一般留空（自动拼 https://{workspaceId}.{region}.maas.aliyuncs.com）；测试/代理可整体覆盖
  },
  vosk: {                  // 本地 Vosk（离线识别，可选，免费）
    modelDir: 'vosk-model-small-cn-0.22', // 解压后的模型目录（相对 server/ 或绝对路径）
    noSpaces: true,        // 去掉中文分词空格（"你 知道" -> "你知道"）；英文单词间的空格不受影响
  },
};
function loadAsrConfig() {
  const merged = Object.assign({}, DEFAULT_ASR, { rootDir: __dirname });
  merged.whisper = Object.assign({}, DEFAULT_ASR.whisper);
  merged.aliyun = Object.assign({}, DEFAULT_ASR.aliyun);
  merged.vosk = Object.assign({}, DEFAULT_ASR.vosk);
  try {
    const doc = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (doc && doc.asr) {
      Object.assign(merged, doc.asr);
      if (doc.asr.whisper) Object.assign(merged.whisper, doc.asr.whisper);
      if (doc.asr.aliyun) Object.assign(merged.aliyun, doc.asr.aliyun);
      if (doc.asr.vosk) Object.assign(merged.vosk, doc.asr.vosk);
      // 兼容旧版平铺配置 asr.whisperBin / asr.model / asr.language / asr.threads
      if (doc.asr.whisperBin && !doc.asr.whisper) merged.whisper.bin = doc.asr.whisperBin;
      if (doc.asr.model && !doc.asr.whisper) merged.whisper.model = doc.asr.model;
      if (doc.asr.language && !doc.asr.whisper) merged.whisper.language = doc.asr.language;
      if (doc.asr.threads != null && !doc.asr.whisper) merged.whisper.threads = doc.asr.threads;
    }
  } catch (e) { /* 使用默认值 */ }
  return merged;
}
let ASR_CFG = loadAsrConfig();
const resolvePath = (p) => (p && !path.isAbsolute(p) ? path.resolve(__dirname, p) : p);

let asrMgr = null;
// 阿里云临时音频目录（WAV 落盘 + /asr-audio/ 路由暴露给阿里云拉取）
const ASR_AUDIO_DIR = resolvePath(ASR_CFG.aliyun.audioDir || 'asr-audio');
if (ASR_CFG.enabled) {
  asrMgr = asr.createAsrManager(Object.assign({}, ASR_CFG, {
    whisper: Object.assign({}, ASR_CFG.whisper, {
      bin: resolvePath(ASR_CFG.whisper.bin),
      model: resolvePath(ASR_CFG.whisper.model),
    }),
    aliyun: Object.assign({}, ASR_CFG.aliyun, { audioDir: ASR_AUDIO_DIR }),
  }), {
    onLine: (roomId, line) => {
      broadcastRoom(roomId, { type: 'asr-line', roomId, t: line.t, kind: line.kind, nickname: line.nickname, text: line.text });
    },
  });
  const aliyunReady = asrMgr.ready('aliyun-bailian');
  const voskReady = asrMgr.ready('local-vosk');
  console.log(`[asr] 默认引擎=${asrMgr.defaultMode} 本地whisper=${asrMgr.ready('local-whisper') ? '就绪' : '未就绪'} 本地vosk=${voskReady ? '就绪' : '未就绪'} 阿里云=${aliyunReady ? '已配置' : '未配置'}${ASR_CFG.mock ? ' [mock 模式]' : ''}`);
  if (aliyunReady) {
    console.log('[asr] 阿里云接口: ' + asrMgr.engineBaseUrl('aliyun-bailian'));
    console.log('[asr] 失败音频保留目录: ' + ASR_AUDIO_DIR + '/failed/（转写失败时可下载试听）');
  }
  if (asrMgr.defaultMode === 'aliyun-bailian' && !aliyunReady) {
    console.log('[asr] 提示：默认引擎是 aliyun-bailian 但未就绪：需在 config.yaml 的 asr.aliyun 配置 apiKey、workspaceId（模型 qwen-audio-3.0-asr-flash 需在百炼控制台开通）');
  }
  if (asrMgr.defaultMode === 'local-vosk' && !voskReady) {
    console.log('[asr] 提示：默认引擎是 local-vosk 但未安装（需 npm install vosk --no-save 并下载模型，见 README）');
  }
  if (asrMgr.defaultMode === 'local-whisper' && !asrMgr.ready('local-whisper')) {
    console.log('[asr] 提示：默认引擎是 local-whisper 但 whisper 未就绪（可运行 setup-whisper.sh 安装）');
  }
} else {
  console.log('[asr] ASR 未启用（config.yaml 的 asr.enabled = false）');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/** 失败音频保留目录（/asr-audio/failed/xxx.wav），转写失败时便于下载试听/手动提交验证 */
function serveAsrAudio(urlPath, res) {
  if (!ASR_AUDIO_DIR) { res.writeHead(404); res.end('Not Found'); return; }
  const rel = urlPath.slice('/asr-audio/'.length);
  if (!rel) { res.writeHead(404); res.end('Not Found'); return; }
  const filePath = path.join(ASR_AUDIO_DIR, path.normalize(rel));
  const root = path.resolve(ASR_AUDIO_DIR);
  if (path.resolve(filePath) !== filePath || !filePath.startsWith(root + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/asr-audio/')) {
    serveAsrAudio(urlPath, res);
    return;
  }
  // 每请求探测 dist 是否存在：构建完成后无需重启服务器即可生效
  const frontendDir = fs.existsSync(UI_DIST) ? UI_DIST : null;
  if (!frontendDir) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(BUILD_HINT_PAGE);
    return;
  }
  const filePath = path.join(frontendDir, path.normalize(urlPath));
  if (!filePath.startsWith(frontendDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退：未知路径返回 index.html（Vite 单页入口）
      fs.readFile(path.join(frontendDir, 'index.html'), (err2, idx) => {
        if (!err2) {
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(idx);
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws' });

/** connectedUsers: clientId -> { ws, nickname, roomId, talking }  roomId 为 null 表示未进房间 */
const connectedUsers = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/** 构建全局用户列表 */
function buildUserList() {
  const list = [];
  for (const [id, info] of connectedUsers) {
    list.push({ id, nickname: info.nickname, roomId: info.roomId, talking: !!info.talking });
  }
  return list;
}

/** 向所有已连接用户广播 */
function broadcastAll(obj) {
  for (const [, info] of connectedUsers) {
    if (info.ws.readyState === info.ws.OPEN) send(info.ws, obj);
  }
}

/** 向某个房间内所有人广播（不含 senderId） */
function broadcastRoom(roomId, obj, exceptId = null) {
  for (const [cid, info] of connectedUsers) {
    if (cid !== exceptId && info.roomId === roomId && info.ws.readyState === info.ws.OPEN) {
      send(info.ws, obj);
    }
  }
}

/** 更新并广播全局用户列表 */
function pushUserList() {
  broadcastAll({ type: 'user-list', users: buildUserList() });
}

/** 房间列表 + 当前 ASR 状态（侧栏显示 ASR 徽标） */
function roomListWithAsr() {
  return ROOMS.map((r) => Object.assign({}, r, { asr: !!(asrMgr && asrMgr.active(r.id)) }));
}

/** 服务端 ASR 能力信息：是否启用、引擎、引擎是否就绪（客户端据此显示按钮状态） */
function asrInfoPayload() {
  const mode = asrMgr ? asrMgr.defaultMode : '';
  return {
    type: 'asr-info',
    enabled: !!asrMgr,
    mode,
    ready: asrMgr ? asrMgr.ready(mode) : false,
  };
}

/** 房间已无人时自动结束 ASR 会话并落盘 */
function maybeEndAsr(roomId) {
  if (!asrMgr) return;
  const sess = asrMgr.active(roomId);
  if (!sess) return;
  for (const [, u] of connectedUsers) {
    if (u.roomId === roomId) return; // 房间里还有人
  }
  const ended = asrMgr.stop(roomId);
  broadcastRoom(roomId, { type: 'asr-state', roomId, on: false, endTs: ended.endTs, file: ended.fileName });
  broadcastAll({ type: 'asr-badge', roomId, on: false });
}

/** 处理加入房间（含切换房间） */
function doJoin(clientId, roomId, nickname) {
  const info = connectedUsers.get(clientId);
  if (!info) return false;

  // 若已在某房间，先离开旧房间
  if (info.roomId) {
    const oldRoom = info.roomId;
    broadcastRoom(oldRoom, { type: 'peer-left', id: clientId }, clientId);
    info.roomId = null;
    // 换房后说话状态复位，并通知旧房间成员取消描边
    if (info.talking) {
      info.talking = false;
      broadcastRoom(oldRoom, { type: 'talking', id: clientId, on: false }, clientId);
    }
    // 被移动/换房后原房间空了则自动结束该房间的 ASR 会话
    if (oldRoom !== roomId) maybeEndAsr(oldRoom);
  }

  info.roomId = roomId;
  info.nickname = nickname;

  // 收集新房间里已有的人
  const peers = [];
  for (const [cid, pi] of connectedUsers) {
    if (cid !== clientId && pi.roomId === roomId) {
      peers.push({ id: cid, nickname: pi.nickname, sharing: !!pi.sharing, talking: !!pi.talking });
    }
  }

  send(info.ws, { type: 'joined', room: roomId, you: clientId, nickname, peers });
  broadcastRoom(roomId, { type: 'peer-joined', peer: { id: clientId, nickname, talking: false } }, clientId);
  pushUserList();
  console.log(`[join] ${clientId} (${nickname}) -> room ${roomId}`);

  // 房间 ASR 已开启时，通知新成员并下发历史日志
  const sess = asrMgr && asrMgr.active(roomId);
  if (sess) {
    send(info.ws, { type: 'asr-state', roomId, on: true, startTs: sess.startTs });
    send(info.ws, { type: 'asr-history', roomId, lines: sess.lines });
  }
  return true;
}

/** 处理离开房间（回到大厅） */
function doLeaveRoom(clientId) {
  const info = connectedUsers.get(clientId);
  if (!info || !info.roomId) return;
  const oldRoom = info.roomId;
  broadcastRoom(oldRoom, { type: 'peer-left', id: clientId }, clientId);
  info.roomId = null;
  info.talking = false;
  send(info.ws, { type: 'left-room' });
  pushUserList();
  console.log(`[leave] ${clientId} <- room`);
  maybeEndAsr(oldRoom);
}

wss.on('connection', (ws, req) => {
  // 分配临时 ID，真正的 ID 在 join 时由客户端提供
  let clientId = null;

  ws.on('message', (raw, isBinary) => {
    // ---- 二进制帧：ASR 音频流 [4B header长度][JSON header][Int16LE PCM @16k] ----
    // 注意：不能依赖 Buffer.isBuffer 区分——ws 的文本帧也可能是 Buffer，必须用 isBinary 标志
    if (isBinary) {
      if (!asrMgr || !clientId || raw.length < 8) return;
      try {
        const hlen = raw.readUInt32BE(0);
        if (hlen <= 0 || hlen > 2048 || raw.length < 4 + hlen + 2) return;
        const header = JSON.parse(raw.slice(4, 4 + hlen).toString('utf8'));
        if (!header || header.type !== 'asr-audio' || !header.room) return;
        const info = connectedUsers.get(clientId);
        if (!info || info.roomId !== header.room) return;
        const pcm = raw.slice(4 + hlen);
        const int16 = (pcm.byteOffset % 2 === 0)
          ? new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1)
          : new Int16Array(Buffer.from(pcm).buffer, 0, pcm.length >> 1);
        asrMgr.feed(header.room, clientId, info.nickname, int16);
      } catch (e) { /* 忽略坏帧 */ }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // 连接后立即上报身份：让服务器登记"在线（大厅）"状态，其他客户端的侧栏能实时看到
      case 'identify': {
        const id = String(msg.id || '').trim();
        const nickname = String(msg.nickname || '匿名').trim().slice(0, 24) || '匿名';
        if (!id) break;
        if (!clientId) {
          clientId = id;
          connectedUsers.set(id, { ws, nickname, roomId: null, talking: false });
          pushUserList();
          console.log(`[identify] ${clientId} (${nickname}) 在线（大厅）`);
        } else if (connectedUsers.has(clientId)) {
          connectedUsers.get(clientId).nickname = nickname;
          pushUserList();
        }
        break;
      }

      case 'get-rooms': {
        ROOMS = loadRooms();
        ICE_SERVERS = loadIceServers();
        send(ws, { type: 'room-list', rooms: roomListWithAsr(), iceServers: ICE_SERVERS });
        send(ws, { type: 'user-list', users: buildUserList() });
        send(ws, asrInfoPayload());
        break;
      }

      case 'join': {
        const id = String(msg.id || '').trim();
        const roomId = String(msg.room || '').trim();
        const nickname = String(msg.nickname || '匿名').trim().slice(0, 24) || '匿名';
        if (!id || !roomId) { send(ws, { type: 'error', message: '缺少机器码或房间' }); return; }

        // 首次 join 时注册 clientId
        if (!clientId) {
          clientId = id;
          connectedUsers.set(id, { ws, nickname, roomId: null, talking: false });
        }

        doJoin(clientId, roomId, nickname);
        break;
      }

      // 客户端上报"正在讲话/停止讲话"（本地音量检测），广播给同房间成员用于名字描边
      case 'talking': {
        if (!clientId) return;
        const info = connectedUsers.get(clientId);
        if (!info) return;
        info.talking = !!msg.on;
        if (info.roomId) {
          broadcastRoom(info.roomId, { type: 'talking', id: clientId, on: info.talking });
          pushUserList(); // 侧栏房间成员列表同步描边
        }
        break;
      }

      case 'leave-room': {
        if (clientId) doLeaveRoom(clientId);
        break;
      }

      case 'signal': {
        if (!clientId) return;
        const target = connectedUsers.get(msg.to);
        if (target && target.roomId) send(target.ws, { type: 'signal', from: clientId, data: msg.data });
        break;
      }

      case 'nickname': {
        if (!clientId) return;
        const nickname = String(msg.nickname || '匿名').trim().slice(0, 24) || '匿名';
        const info = connectedUsers.get(clientId);
        if (info) {
          info.nickname = nickname;
          broadcastRoom(info.roomId, { type: 'nickname', id: clientId, nickname });
          pushUserList();
        }
        break;
      }

      case 'share-state': {
        if (!clientId) return;
        const info = connectedUsers.get(clientId);
        if (info) {
          info.sharing = !!msg.sharing;
          if (info.roomId) {
            broadcastRoom(info.roomId, { type: 'share-state', id: clientId, sharing: !!msg.sharing, muted: !!msg.muted }, clientId);
          }
        }
        break;
      }

      // 房间 ASR（语音转写）开关；每次开->关为一个 group，服务端落盘 房间-开始-结束.txt
      // 转写引擎由服务端 config.yaml 的 asr.mode 决定（客户端不可选）
      case 'asr-toggle': {
        if (!asrMgr) { send(ws, { type: 'error', message: '服务器未启用 ASR 功能' }); return; }
        const mode = asrMgr.defaultMode;
        if (!asrMgr.ready(mode)) {
          const MODE_ERR = {
            'aliyun-bailian': '阿里云转写未配置（需要在 config.yaml 的 asr.aliyun 配置 apiKey 与 workspaceId）',
            'local-vosk': '本地 Vosk 不可用（未安装 vosk 模块或模型目录不存在，见 README 安装说明）',
          };
          send(ws, { type: 'error', message: MODE_ERR[mode] || '本地 whisper 不可用（未找到 whisper 程序或模型，可运行 setup-whisper.sh 安装）' });
          return;
        }
        const info = connectedUsers.get(clientId);
        if (!info || !info.roomId) { send(ws, { type: 'error', message: '请先加入房间再开启转写' }); return; }
        const roomId = info.roomId;
        const roomName = ((ROOMS.find((r) => r.id === roomId)) || {}).name || roomId;
        if (msg.on) {
          if (asrMgr.active(roomId)) return; // 已开启
          const sess = asrMgr.start(roomId, roomName, mode);
          if (!sess) { send(ws, { type: 'error', message: '转写启动失败（引擎不可用）' }); return; }
          broadcastRoom(roomId, { type: 'asr-state', roomId, on: true, startTs: sess.startTs, mode: sess.mode });
          broadcastAll({ type: 'asr-badge', roomId, on: true });
          console.log(`[asr] ${clientId} (${info.nickname}) 开启了房间 ${roomId} 的转写（引擎=${sess.mode}）`);
        } else {
          const sess = asrMgr.active(roomId);
          if (!sess) return; // 未开启
          const ended = asrMgr.stop(roomId);
          broadcastRoom(roomId, { type: 'asr-state', roomId, on: false, endTs: ended.endTs, file: ended.fileName, mode: ended.mode });
          broadcastAll({ type: 'asr-badge', roomId, on: false });
          console.log(`[asr] ${clientId} (${info.nickname}) 关闭了房间 ${roomId} 的转写`);
        }
        break;
      }

      // 移动其他用户到指定房间
      case 'move-user': {
        if (!clientId) return;
        const target = connectedUsers.get(msg.targetId);
        if (!target) { send(ws, { type: 'error', message: '目标用户不在线' }); return; }
        doJoin(msg.targetId, String(msg.roomId), target.nickname);
        send(target.ws, { type: 'moved', roomId: msg.roomId, by: clientId });
        break;
      }

      // 邀请其他用户进入自己的房间
      case 'invite': {
        if (!clientId) return;
        const info = connectedUsers.get(clientId);
        if (!info || !info.roomId) { send(ws, { type: 'error', message: '你不在任何房间' }); return; }
        const target = connectedUsers.get(msg.targetId);
        if (!target) { send(ws, { type: 'error', message: '目标用户不在线' }); return; }
        send(target.ws, { type: 'invite', from: clientId, fromNick: info.nickname, roomId: info.roomId, roomName: msg.roomName || '' });
        break;
      }

      // 被邀请者接受邀请
      case 'invite-accept': {
        if (!clientId) return;
        const target = connectedUsers.get(clientId);
        if (target) doJoin(clientId, String(msg.roomId), target.nickname);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (clientId) {
      const info = connectedUsers.get(clientId);
      // 同机器码重连竞态保护：若该 clientId 的登记已被新连接替换（info.ws !== ws），
      // 说明这是旧连接的 socket 迟到关闭（如网络半开/刷新时旧连接延迟断开），
      // 不能删除新连接的登记，否则新客户端会从 user-list 消失且收不到任何广播。
      if (!info || info.ws !== ws) return;
      const roomId = info.roomId;
      if (roomId) {
        broadcastRoom(roomId, { type: 'peer-left', id: clientId });
      }
      connectedUsers.delete(clientId);
      pushUserList();
      console.log(`[disconnect] ${clientId}`);
      if (roomId) maybeEndAsr(roomId);
    }
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '<公网IP>' : HOST;
  console.log(`screen-connect 信令服务器已启动: http://${HOST}:${PORT}`);
  console.log(`WebSocket: ws://${displayHost}:${PORT}/ws`);
  console.log(`前端静态托管: ui/dist（每请求实时检测，未构建时返回引导页提示 pnpm build:ui）`);
  console.log(`按 Ctrl+C 停止`);
});
