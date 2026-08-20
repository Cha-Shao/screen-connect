/**
 * screen-connect 信令服务器 v2
 * - 静态托管 ../shared 前端
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

const PORT = process.env.PORT || 1454;
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const CONFIG_PATH = path.join(__dirname, 'config.yaml');

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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(SHARED_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(SHARED_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws' });

/** connectedUsers: clientId -> { ws, nickname, roomId }  roomId 为 null 表示未进房间 */
const connectedUsers = new Map();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

/** 构建全局用户列表 */
function buildUserList() {
  const list = [];
  for (const [id, info] of connectedUsers) {
    list.push({ id, nickname: info.nickname, roomId: info.roomId });
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

/** 处理加入房间（含切换房间） */
function doJoin(clientId, roomId, nickname) {
  const info = connectedUsers.get(clientId);
  if (!info) return false;

  // 若已在某房间，先离开旧房间
  if (info.roomId) {
    broadcastRoom(info.roomId, { type: 'peer-left', id: clientId }, clientId);
  }

  info.roomId = roomId;
  info.nickname = nickname;

  // 收集新房间里已有的人
  const peers = [];
  for (const [cid, pi] of connectedUsers) {
    if (cid !== clientId && pi.roomId === roomId) {
      peers.push({ id: cid, nickname: pi.nickname, sharing: !!pi.sharing });
    }
  }

  send(info.ws, { type: 'joined', room: roomId, you: clientId, nickname, peers });
  broadcastRoom(roomId, { type: 'peer-joined', peer: { id: clientId, nickname } }, clientId);
  pushUserList();
  console.log(`[join] ${clientId} (${nickname}) -> room ${roomId}`);
  return true;
}

/** 处理离开房间（回到大厅） */
function doLeaveRoom(clientId) {
  const info = connectedUsers.get(clientId);
  if (!info || !info.roomId) return;
  broadcastRoom(info.roomId, { type: 'peer-left', id: clientId }, clientId);
  info.roomId = null;
  send(info.ws, { type: 'left-room' });
  pushUserList();
  console.log(`[leave] ${clientId} <- room`);
}

wss.on('connection', (ws, req) => {
  // 分配临时 ID，真正的 ID 在 join 时由客户端提供
  let clientId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'get-rooms': {
        ROOMS = loadRooms();
        ICE_SERVERS = loadIceServers();
        send(ws, { type: 'room-list', rooms: ROOMS, iceServers: ICE_SERVERS });
        send(ws, { type: 'user-list', users: buildUserList() });
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
          connectedUsers.set(id, { ws, nickname, roomId: null });
        }

        doJoin(clientId, roomId, nickname);
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
      if (info && info.roomId) {
        broadcastRoom(info.roomId, { type: 'peer-left', id: clientId });
      }
      connectedUsers.delete(clientId);
      pushUserList();
      console.log(`[disconnect] ${clientId}`);
    }
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
});

server.listen(PORT, () => {
  console.log(`screen-connect 信令服务器已启动: http://0.0.0.0:${PORT}`);
  console.log(`WebSocket: ws://<公网IP>:${PORT}/ws`);
  console.log(`按 Ctrl+C 停止`);
});
