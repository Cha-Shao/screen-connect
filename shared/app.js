'use strict';
/* screen-connect 客户端逻辑 v2（浏览器 & Tauri 共用）
 * - 修复 bug：ws.onmessage 在 ensureMic 之前注册，避免丢失服务器自动下发的 room-list
 * - 加载动画 splash + 模态弹窗 + Toast
 * - 持久侧栏：房间列表(list) + 大厅用户列表 + 拖拽移动用户 + 邀请
 * - WebRTC mesh + 屏幕共享 1080p/60fps + 每人音量 + 播放/暂停 + 放大多选
 */

const $ = (s) => document.querySelector(s);

let RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:www.elfmc.com:3478' },
    { urls: 'turn:www.elfmc.com:3478', username: 'elfmcapp', credential: '123456' },
    { urls: 'turn:www.elfmc.com:3478?transport=tcp', username: 'elfmcapp', credential: '123456' },
  ],
};

// ---- 状态 ----
let ws = null;
let myId = '';
let myNick = '';
let room = '';
let roomName = '';
let localMic = null;
let localMicTrack = null;
let micEnabled = true;
let screenStream = null;
let screenTrack = null;
let sharing = false;
let connected = false;
let shareResolution = 1080;
let shareFramerate = 60;
let noiseMode = localStorage.getItem('sc_noise_mode') || 'none';
let rawMic = null;
let webrtcMic = null;
let rnnoiseCtx = null;
let rnnoiseWasmModule = null;
let rnnoisePipeline = null;

// 全局列表
let roomDefs = [];
let allUsers = []; // [{id, nickname, roomId}]

// WebRTC
const pcs = {};
const audioSenders = {};
const screenSenders = {};
const negotiator = {};
const peerStream = {};
const peerNick = {};
const peerState = {};
const peerCards = {};
const peerAudio = {};
const pinVideos = {};

// 拖拽锁：拖拽过程中不重新渲染侧栏，避免 DOM 重建中断拖拽
let isDragging = false;
let pendingSidebarRender = false;

// ---- Tauri 机器码 ----
function tauriInvoke(cmd) {
  const t = window.__TAURI__;
  if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke(cmd);
  if (t && typeof t.invoke === 'function') return t.invoke(cmd);
  if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') return window.__TAURI_INTERNALS__.invoke(cmd);
  throw new Error('tauri invoke 不可用');
}
async function waitTauri(maxMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const t = window.__TAURI__;
    if ((t && t.core && typeof t.core.invoke === 'function') || (t && typeof t.invoke === 'function') || (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function')) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

// ---- 工具 ----
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function hashHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  let h2 = 0xcbf29ce4;
  for (let i = str.length - 1; i >= 0; i--) { h2 ^= str.charCodeAt(i); h2 = Math.imul(h2, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function formatId(raw) {
  const hex = String(raw).replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 16);
  return (hex || '0000000000000000').replace(/(.{4})/g, '$1-').replace(/-$/, '');
}
async function getMachineId() {
  if (await waitTauri()) {
    try {
      const id = await Promise.race([tauriInvoke('get_machine_id'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      if (id) return formatId(id);
    } catch (e) { console.warn('Rust get_machine_id 失败，回退浏览器模式', e); }
  }
  let id = localStorage.getItem('sc_machine_id');
  if (!id) {
    const seed = [navigator.userAgent, screen.width + 'x' + screen.height, navigator.hardwareConcurrency || 0, Intl.DateTimeFormat().resolvedOptions().timeZone || '', uuid()].join('|');
    id = 'WEB-' + hashHex(seed).slice(0, 12).toUpperCase();
    localStorage.setItem('sc_machine_id', id);
  }
  return id;
}

// ---- 提示音 ----
let audioCtx = null;
function playSound(type) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const notes = type === 'join' ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.1;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.start(t);
      osc.stop(t + 0.1);
    });
  } catch (e) {}
}

// ---- Modal & Toast ----
function showModal({ icon = '', title = '', body = '', spinner = false, actions = [] }) {
  $('#modalIcon').innerHTML = spinner ? '<div class="sc-modal-spinner"></div>' : icon;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const wrap = $('#modalActions'); wrap.innerHTML = '';
  if (actions.length === 0) {
    // 不可关闭的等待框
  } else {
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.text; b.className = a.cancel ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm';
      b.onclick = () => { hideModal(); a.onClick && a.onClick(); };
      wrap.appendChild(b);
    }
  }
  $('#modal').classList.remove('hidden');
}
function hideModal() { $('#modal').classList.add('hidden'); }
let toastTimer = null;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}
function setLobbyMsg(t) { $('#lobbyMsg').textContent = t || ''; }

// ---- 信令 ----
function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function signal(to, data) { wsSend({ type: 'signal', to, data }); }
function buildWsUrl() {
  let v = $('#serverHost').value.trim();
  const wss = $('#wssCheck').checked;
  if (!v) return '';
  if (/^wss?:\/\//i.test(v)) return v;
  v = v.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  // 不带端口时默认补 1454
  if (!/:\d/.test(v.split('/')[0])) {
    const idx = v.indexOf('/');
    v = idx >= 0 ? v.slice(0, idx) + ':1454' + v.slice(idx) : v + ':1454';
  }
  const path = v.endsWith('/ws') ? '' : '/ws';
  return (wss ? 'wss://' : 'ws://') + v + path;
}
function connectWs(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.onopen = () => resolve(sock);
    sock.onerror = () => reject(new Error('无法连接服务器，请检查地址/网络/防火墙'));
    sock.onclose = () => {};
  });
}

// ---- WebRTC ----
function ensurePC(peerId) {
  if (pcs[peerId]) return pcs[peerId];
  const pc = new RTCPeerConnection(RTC_CONFIG);
  pcs[peerId] = pc;
  negotiator[peerId] = { makingOffer: false, ignoreOffer: false };

  const audioT = pc.addTransceiver('audio', { direction: 'sendrecv' });
  audioSenders[peerId] = audioT.sender;
  if (localMicTrack) audioT.sender.replaceTrack(localMicTrack);

  if (screenTrack && screenStream) {
    try {
      const sender = pc.addTrack(screenTrack, screenStream);
      screenSenders[peerId] = sender;
      boostSender(sender);
    } catch (e) { console.warn('addTrack on new PC', peerId, e); }
  }

  pc.ontrack = (e) => {
    const stream = peerStream[peerId];
    if (e.track.kind === 'video') {
      for (const t of stream.getVideoTracks()) stream.removeTrack(t);
    }
    stream.addTrack(e.track);
    if (e.track.kind === 'audio') {
      const a = peerAudio[peerId];
      if (a) { a.srcObject = stream; a.play().catch(() => {}); }
    } else {
      e.track.onunmute = () => { syncPeerVideo(peerId); };
      e.track.onmute = () => {
        if (peerState[peerId] && peerState[peerId].playing) {
          if (peerCards[peerId]) peerCards[peerId].inlineEl.srcObject = null;
        }
      };
      e.track.onended = () => {
        stream.removeTrack(e.track);
        if (peerState[peerId] && peerState[peerId].playing) {
          if (peerCards[peerId]) peerCards[peerId].inlineEl.srcObject = null;
        }
      };
      syncPeerVideo(peerId);
    }
  };
  pc.onicecandidate = (e) => { if (e.candidate) signal(peerId, { type: 'candidate', candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'failed' || st === 'disconnected') { try { pc.restartIce && pc.restartIce(); } catch {} }
    if (st === 'closed') removePeer(peerId);
  };
  return pc;
}
function getShareBitrate() {
  if (shareResolution === 1080) return shareFramerate === 60 ? 6_000_000 : 4_000_000;
  return shareFramerate === 60 ? 3_500_000 : 2_000_000;
}
async function boostSender(sender) {
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = getShareBitrate();
    p.encodings[0].maxFramerate = shareFramerate;
    p.degradationPreference = 'maintain-framerate';
    await sender.setParameters(p);
  } catch (e) {}
}
async function makeOffer(peerId) {
  const pc = ensurePC(peerId);
  if (pc.signalingState !== 'stable') return;
  try {
    negotiator[peerId].makingOffer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal(peerId, { type: 'offer', sdp: offer });
  } catch (e) { console.warn('makeOffer failed', peerId, e); }
  finally { negotiator[peerId].makingOffer = false; }
}
async function onSignal(from, data) {
  const pc = ensurePC(from);
  const neg = negotiator[from];
  try {
    if (data.type === 'offer') {
      const collision = neg.makingOffer || pc.signalingState !== 'stable';
      const polite = from < myId;
      neg.ignoreOffer = !polite && collision;
      if (neg.ignoreOffer) return;
      if (collision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription(data.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      signal(from, { type: 'answer', sdp: ans });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'candidate') {
      try { await pc.addIceCandidate(data.candidate); } catch {}
    }
  } catch (e) { console.warn('信令处理失败', from, e); }
}

// ---- 房间成员卡片 ----
function ensurePeerCard(peerId) {
  if (peerCards[peerId]) return peerCards[peerId];
  const card = document.createElement('div'); card.className = 'peer-card';
  const top = document.createElement('div'); top.className = 'pc-top';
  const name = document.createElement('span'); name.className = 'pc-name';
  const tags = document.createElement('span'); tags.className = 'pc-tags';
  top.append(name, tags);
  const inline = document.createElement('video'); inline.className = 'pc-inline'; inline.autoplay = true; inline.playsInline = true; inline.muted = true;
  const vol = document.createElement('div'); vol.className = 'pc-vol';
  const vico = document.createElement('span'); vico.className = 'ico'; vico.textContent = '🔊';
  const range = document.createElement('input'); range.type = 'range'; range.min = 0; range.max = 100; range.value = 100;
  const val = document.createElement('span'); val.className = 'pc-vol-val'; val.textContent = '100';
  range.addEventListener('input', () => { val.textContent = range.value; if (peerAudio[peerId]) peerAudio[peerId].volume = range.value / 100; });
  vol.append(vico, range, val);
  const acts = document.createElement('div'); acts.className = 'pc-acts';
  const playBtn = document.createElement('button'); playBtn.className = 'play'; playBtn.innerHTML = '<span>▶</span><span>播放</span>';
  const pinBtn = document.createElement('button'); pinBtn.className = 'pin'; pinBtn.innerHTML = '<span>⤢</span><span>放大</span>';
  playBtn.onclick = () => togglePlay(peerId);
  pinBtn.onclick = () => togglePin(peerId);
  acts.append(playBtn, pinBtn);
  card.append(top, inline, vol, acts);
  $('#peerGrid').appendChild(card);
  peerCards[peerId] = card; peerStream[peerId] = peerStream[peerId] || new MediaStream();
  const a = document.createElement('audio'); a.autoplay = true; a.volume = 1; document.body.appendChild(a);
  peerAudio[peerId] = a;
  card.nameEl = name; card.tagsEl = tags; card.inlineEl = inline; card.playBtn = playBtn; card.pinBtn = pinBtn;
  name.textContent = peerNick[peerId] || peerId.slice(0, 11);
  togglePeerEmpty();
  return card;
}
function refreshPeerTags(peerId) {
  const card = peerCards[peerId]; if (!card) return;
  const st = peerState[peerId] || {};
  card.classList.toggle('sharing', !!st.sharing);
  card.classList.toggle('pinned', !!st.pinned);
  card.classList.toggle('playing', !!st.playing);
  card.playBtn.classList.toggle('active', !!st.playing);
  card.pinBtn.classList.toggle('active', !!st.pinned);
  card.playBtn.querySelector('span:last-child').textContent = st.playing ? '暂停' : '播放';
  card.playBtn.querySelector('span:first-child').textContent = st.playing ? '⏸' : '▶';
  card.pinBtn.querySelector('span:last-child').textContent = st.pinned ? '取消' : '放大';
  let html = '';
  if (st.sharing) html += '<span class="tag sharing-tag">共享</span>';
  if (st.muted) html += '<span class="tag muted-tag">静音</span>';
  card.tagsEl.innerHTML = html;
  updateShareCount();
}
function togglePlay(peerId) {
  const st = peerState[peerId] = peerState[peerId] || {};
  st.playing = !st.playing;
  const card = peerCards[peerId];
  if (st.playing) { card.inlineEl.srcObject = peerStream[peerId]; card.inlineEl.play().catch(() => {}); }
  else { card.inlineEl.srcObject = null; }
  refreshPeerTags(peerId);
}
function togglePin(peerId) {
  const st = peerState[peerId] = peerState[peerId] || {};
  st.pinned = !st.pinned;
  if (st.pinned) {
    const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = true;
    const tile = document.createElement('div'); tile.className = 'pin-tile';
    const pn = document.createElement('div'); pn.className = 'pname'; pn.textContent = peerNick[peerId] || peerId.slice(0, 11);
    const un = document.createElement('button'); un.className = 'mini unpin'; un.textContent = '✕ 取消';
    un.onclick = () => togglePin(peerId);
    tile.append(v, pn, un);
    v.srcObject = peerStream[peerId]; v.play().catch(() => {});
    $('#pinGrid').appendChild(tile);
    pinVideos[peerId] = { video: v, tile };
  } else {
    const p = pinVideos[peerId];
    if (p) { p.tile.remove(); delete pinVideos[peerId]; }
  }
  refreshPeerTags(peerId); refreshPinView();
}
function syncPeerVideo(peerId) {
  const stream = peerStream[peerId];
  const st = peerState[peerId] || {};
  if (st.playing && peerCards[peerId]) { peerCards[peerId].inlineEl.srcObject = stream; peerCards[peerId].inlineEl.play().catch(() => {}); }
  if (st.pinned && pinVideos[peerId]) { pinVideos[peerId].video.srcObject = stream; pinVideos[peerId].video.play().catch(() => {}); }
}
function refreshPinView() {
  const n = Object.keys(pinVideos).length;
  $('#pinGrid').classList.toggle('hidden', n === 0);
  $('#selfTile').classList.toggle('hidden', n > 0);
  $('#pinHint').classList.toggle('hidden', n === 0);
  $('#pinCount').textContent = n;
}
function updateShareCount() {
  const n = Object.values(peerState).filter((s) => s.sharing).length;
  const el = $('#shareCount');
  el.textContent = n > 0 ? (n + ' 共享中') : '';
  el.classList.toggle('hidden', n === 0);
}
function removePeer(peerId) {
  const pc = pcs[peerId];
  if (pc) { try { pc.close(); } catch {} delete pcs[peerId]; }
  delete screenSenders[peerId]; delete audioSenders[peerId]; delete negotiator[peerId];
  const card = peerCards[peerId]; if (card) card.remove();
  const p = pinVideos[peerId]; if (p) p.tile.remove();
  if (peerAudio[peerId]) peerAudio[peerId].remove();
  delete peerCards[peerId]; delete peerStream[peerId]; delete peerNick[peerId];
  delete peerState[peerId]; delete peerAudio[peerId]; delete pinVideos[peerId];
  refreshPinView(); updateShareCount(); togglePeerEmpty();
}
function togglePeerEmpty() { $('#peerEmpty').classList.toggle('hidden', Object.keys(peerCards).length > 0); }

// ---- 媒体采集 ----
async function enumerateMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const sel = $('#micDevice');
    const cur = sel.value;
    sel.innerHTML = '';
    for (const m of mics) {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      opt.textContent = m.label || ('麦克风 ' + (sel.children.length + 1));
      sel.appendChild(opt);
    }
    if (cur) sel.value = cur;
    return mics;
  } catch (e) { return []; }
}

async function ensureMic(deviceId) {
  const constraints = { echoCancellation: true, noiseSuppression: false, autoGainControl: true };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  try {
    const newMic = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    const newTrack = newMic.getAudioTracks()[0];
    newTrack.enabled = micEnabled;

    if (rawMic) { rawMic.getTracks().forEach((t) => t.stop()); }
    rawMic = newMic;
    localMic = newMic;
    localMicTrack = newTrack;

    await applyNoiseMode(noiseMode, deviceId);

    if (!deviceId) enumerateMicDevices();
    return true;
  } catch (e) { console.warn('ensureMic 失败', e); return false; }
}

async function applyNoiseMode(mode, micDeviceId) {
  noiseMode = mode;
  localStorage.setItem('sc_noise_mode', mode);

  // 更新 UI
  document.querySelectorAll('.noise-opt').forEach((el) => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  const nbtn = $('#noiseBtn');
  if (nbtn) {
    nbtn.classList.toggle('btn-primary', mode !== 'none');
    nbtn.classList.toggle('btn-ghost', mode === 'none');
    const labels = { none: '降噪', rnnoise: 'RNNoise', webrtc: 'ANS' };
    nbtn.querySelector('.t').textContent = labels[mode] || '降噪';
  }

  if (!rawMic) return;

  // 清理上一种模式
  if (webrtcMic) { webrtcMic.getTracks().forEach((t) => t.stop()); webrtcMic = null; }
  if (rnnoisePipeline) {
    try { rnnoisePipeline.source.disconnect(); rnnoisePipeline.node.disconnect(); } catch {}
    rnnoisePipeline = null;
  }

  let newTrack;
  if (mode === 'none') {
    newTrack = rawMic.getAudioTracks()[0];
  } else if (mode === 'webrtc') {
    const c = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const devId = micDeviceId || ($('#micDevice') && $('#micDevice').value);
    if (devId) c.deviceId = { exact: devId };
    webrtcMic = await navigator.mediaDevices.getUserMedia({ audio: c });
    webrtcMic.getAudioTracks()[0].enabled = micEnabled;
    newTrack = webrtcMic.getAudioTracks()[0];
  } else if (mode === 'rnnoise') {
    if (!rnnoiseCtx) rnnoiseCtx = new AudioContext();
    if (rnnoiseCtx.state === 'suspended') await rnnoiseCtx.resume();
    if (!rnnoiseWasmModule) {
      const buf = await (await fetch('rnnoise.wasm')).arrayBuffer();
      rnnoiseWasmModule = await WebAssembly.compile(buf);
    }
    await rnnoiseCtx.audioWorklet.addModule('rnnoise.worklet.js');
    const source = rnnoiseCtx.createMediaStreamSource(rawMic);
    const node = new AudioWorkletNode(rnnoiseCtx, 'rnnoise', {
      channelCountMode: 'explicit', channelCount: 1, channelInterpretation: 'speakers',
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { module: rnnoiseWasmModule },
    });
    const dest = rnnoiseCtx.createMediaStreamDestination();
    source.connect(node); node.connect(dest);
    rnnoisePipeline = { source, node, dest };
    newTrack = dest.stream.getAudioTracks()[0];
  }

  localMicTrack = newTrack;
  for (const pid in audioSenders) {
    if (audioSenders[pid]) {
      try { await audioSenders[pid].replaceTrack(newTrack); } catch (e) {}
    }
  }
}
async function startShare() {
  try {
    const w = shareResolution === 1080 ? 1920 : 1280;
    const h = shareResolution === 1080 ? 1080 : 720;
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: shareFramerate, max: shareFramerate } }, audio: false,
    });
    screenTrack = screenStream.getVideoTracks()[0];
    screenTrack.onended = stopShare;
    sharing = true;
    $('#selfVideo').srcObject = screenStream;
    $('#selfTile').classList.add('self-sharing');
    for (const pid in pcs) {
      try {
        const sender = pcs[pid].addTrack(screenTrack, screenStream);
        screenSenders[pid] = sender;
        boostSender(sender);
      } catch (e) { console.warn('addTrack', pid, e); }
    }
    for (const pid in pcs) { renegotiate(pid); }
    const btn = $('#shareBtn'); btn.classList.add('btn-warning'); btn.querySelector('.t').textContent = '停止共享';
    wsSend({ type: 'share-state', sharing: true, muted: !micEnabled });
  } catch (e) { if (e.name !== 'NotAllowedError') toast('共享失败：' + e.message); }
}
function stopShare() {
  if (screenTrack) { try { screenTrack.stop(); } catch {} }
  screenTrack = null; screenStream = null; sharing = false;
  $('#selfVideo').srcObject = null;
  $('#selfTile').classList.remove('self-sharing');
  for (const pid in screenSenders) {
    if (screenSenders[pid] && pcs[pid]) {
      try { pcs[pid].removeTrack(screenSenders[pid]); } catch (e) {}
    }
  }
  Object.keys(screenSenders).forEach((k) => delete screenSenders[k]);
  for (const pid in pcs) { renegotiate(pid); }
  const btn = $('#shareBtn'); btn.classList.remove('btn-warning'); btn.querySelector('.t').textContent = '共享屏幕';
  wsSend({ type: 'share-state', sharing: false, muted: !micEnabled });
}
async function updateSenderParams() {
  for (const pid in screenSenders) {
    if (screenSenders[pid]) {
      try {
        const p = screenSenders[pid].getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = getShareBitrate();
        p.encodings[0].maxFramerate = shareFramerate;
        p.degradationPreference = 'maintain-framerate';
        await screenSenders[pid].setParameters(p);
      } catch (e) {}
    }
  }
}

async function renegotiate(peerId) {
  const pc = pcs[peerId];
  if (!pc || pc.signalingState !== 'stable') return;
  try {
    negotiator[peerId].makingOffer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal(peerId, { type: 'offer', sdp: offer });
  } catch (e) { console.warn('renegotiate failed', peerId, e); }
  finally { negotiator[peerId].makingOffer = false; }
}

// ---- 侧栏渲染 ----
function renderSidebar() {
  if (isDragging) { pendingSidebarRender = true; return; }
  // 房间列表
  const rl = $('#roomList'); rl.innerHTML = '';
  for (const rd of roomDefs) {
    const item = document.createElement('div');
    item.className = 'room-item' + (room === rd.id ? ' active' : '');
    item.dataset.roomId = rd.id;

    const name = document.createElement('div'); name.className = 'ri-name'; name.textContent = rd.name;
    item.appendChild(name);
    if (rd.desc) { const d = document.createElement('div'); d.className = 'ri-desc'; d.textContent = rd.desc; item.appendChild(d); }

    const usersInRoom = allUsers.filter((u) => u.roomId === rd.id);
    if (usersInRoom.length) {
      const uc = document.createElement('div'); uc.className = 'ri-count'; uc.textContent = usersInRoom.length + ' 人';
      item.appendChild(uc);
      const uw = document.createElement('div'); uw.className = 'ri-users';
      for (const u of usersInRoom) {
        const chip = document.createElement('span');
        chip.className = 'ru' + (u.id === myId ? ' me' : '');
        chip.textContent = u.nickname;
        chip.dataset.uid = u.id;
        chip.draggable = u.id !== myId;
        chip.title = u.id === myId ? '你' : ('拖动到其他房间');
        chip.addEventListener('dragstart', (e) => {
          isDragging = true;
          e.dataTransfer.setData('text/plain', u.id);
          e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', () => {
          isDragging = false;
          if (pendingSidebarRender) { pendingSidebarRender = false; renderSidebar(); }
        });
        uw.appendChild(chip);
      }
      item.appendChild(uw);
    }

    // 拖放目标
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault(); item.classList.remove('drag-over');
      const uid = e.dataTransfer.getData('text/plain');
      if (uid) moveUserToRoom(uid, rd.id, rd.name);
    });

    item.onclick = () => { if (room !== rd.id) joinRoomById(rd.id, rd.name); };
    rl.appendChild(item);
  }

  // 大厅用户
  const lu = $('#lobbyUsers'); lu.innerHTML = '';
  const lobby = allUsers.filter((u) => !u.roomId && u.id !== myId);
  $('#lobbyEmpty').classList.toggle('hidden', lobby.length > 0);
  for (const u of lobby) {
    const row = document.createElement('div'); row.className = 'lobby-user'; row.draggable = true;
    const dot = document.createElement('span'); dot.className = 'lu-dot';
    const nm = document.createElement('span'); nm.className = 'lu-name'; nm.textContent = u.nickname;
    const inv = document.createElement('button'); inv.className = 'lu-invite'; inv.textContent = '邀请';
    inv.onclick = (e) => { e.stopPropagation(); inviteUser(u.id, u.nickname); };
    row.append(dot, nm, inv);
    row.dataset.uid = u.id;
    row.addEventListener('dragstart', (e) => {
      isDragging = true;
      e.dataTransfer.setData('text/plain', u.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      isDragging = false;
      if (pendingSidebarRender) { pendingSidebarRender = false; renderSidebar(); }
    });
    lu.appendChild(row);
  }

  // 在线人数
  $('#onlineCount').textContent = allUsers.length + ' 人在线';
}

function moveUserToRoom(uid, targetRoomId, targetRoomName) {
  const u = allUsers.find((x) => x.id === uid);
  if (!u) return;
  if (uid === myId) { toast('不能移动自己，请点击房间名加入'); return; }
  wsSend({ type: 'move-user', targetId: uid, roomId: targetRoomId });
  toast(`已将 ${u.nickname} 移至「${targetRoomName}」`);
}

function inviteUser(uid, uname) {
  if (!room) { toast('请先加入一个房间再邀请'); return; }
  wsSend({ type: 'invite', targetId: uid, roomName });
  toast(`已邀请 ${uname} 加入「${roomName}」`);
}

// ---- 流程 ----
async function connectServer() {
  const wsUrl = buildWsUrl();
  const host = $('#serverHost').value.trim();
  const nick = $('#nickInput').value.trim() || '匿名';
  if (!host) { setLobbyMsg('请填写服务器地址'); return; }

  showModal({ spinner: true, title: '连接服务器中', body: '正在连接 ' + host + '…' });

  try {
    ws = await connectWs(wsUrl);
  } catch (e) {
    hideModal();
    setLobbyMsg(e.message);
    return;
  }

  localStorage.setItem('sc_host', host);
  localStorage.setItem('sc_wss', $('#wssCheck').checked ? '1' : '0');
  myNick = nick;
  localStorage.setItem('sc_nick', nick);

  // ★ 关键修复：先注册 onmessage，再请求麦克风，避免丢失服务器自动下发的 room-list
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleServerMsg(m);
  };
  ws.onclose = () => {
    connected = false;
    hideModal();
    $('#main').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    setLobbyMsg('与服务器的连接已断开');
  };

  // 麦克风在后台获取（不阻塞信令），获取后枚举设备列表
  ensureMic().then(() => { enumerateMicDevices(); });

  // 主动请求房间列表和用户列表（服务器也会自动下发，这里兜底）
  wsSend({ type: 'get-rooms' });

  hideModal();
  connected = true;
  $('#lobby').classList.add('hidden');
  $('#main').classList.remove('hidden');
  $('#quitBtn').classList.add('hidden');
  $('#leaveBtn').classList.remove('hidden');
}

function handleServerMsg(m) {
  switch (m.type) {
    case 'room-list':
      roomDefs = m.rooms || [];
      if (m.iceServers && m.iceServers.length) RTC_CONFIG.iceServers = m.iceServers;
      renderSidebar();
      break;
    case 'user-list':
      allUsers = m.users || [];
      renderSidebar();
      break;
    case 'joined':
      // 进入房间（或被移动到新房间）
      if (room && room !== m.room) { clearRoomPeers(); }
      room = m.room; myNick = m.nickname;
      const rd = roomDefs.find((r) => r.id === m.room);
      roomName = rd ? rd.name : m.room;
      for (const p of (m.peers || [])) {
        peerNick[p.id] = p.nickname;
        if (p.sharing) { peerState[p.id] = peerState[p.id] || {}; peerState[p.id].sharing = true; }
        ensurePeerCard(p.id);
        if (p.sharing) refreshPeerTags(p.id);
      }
      for (const p of (m.peers || [])) makeOffer(p.id);
      enterRoom();
      break;
    case 'left-room':
      clearRoomPeers();
      room = ''; roomName = '';
      showNoRoom();
      break;
    case 'moved':
      toast('你被移动到房间「' + (roomDefs.find(r => r.id === m.roomId)?.name || m.roomId) + '」');
      break;
    case 'peer-joined':
      peerNick[m.peer.id] = m.peer.nickname;
      ensurePeerCard(m.peer.id);
      playSound('join');
      if (sharing) wsSend({ type: 'share-state', sharing: true, muted: !micEnabled });
      break;
    case 'signal':
      onSignal(m.from, m.data);
      break;
    case 'nickname':
      peerNick[m.id] = m.nickname;
      if (peerCards[m.id]) peerCards[m.id].nameEl.textContent = m.nickname;
      if (pinVideos[m.id]) pinVideos[m.id].tile.querySelector('.pname').textContent = m.nickname;
      break;
    case 'share-state':
      peerState[m.id] = peerState[m.id] || {};
      peerState[m.id].sharing = m.sharing; peerState[m.id].muted = m.muted;
      refreshPeerTags(m.id);
      if (m.sharing) {
        // 对方开始共享，确保视频流同步到正在播放/固定的元素
        syncPeerVideo(m.id);
      } else {
        // 对方停止共享，清理本地播放/固定画面
        if (peerState[m.id].playing) togglePlay(m.id);
        if (peerState[m.id].pinned) togglePin(m.id);
      }
      break;
    case 'peer-left':
      removePeer(m.id);
      playSound('leave');
      break;
    case 'invite':
      showModal({
        icon: '✉️', title: '加入邀请',
        body: `<b>${m.fromNick}</b> 邀请你加入房间「${m.roomName || m.roomId}」`,
        actions: [
          { text: '接受', onClick: () => wsSend({ type: 'invite-accept', roomId: m.roomId }) },
          { text: '拒绝', cancel: true },
        ],
      });
      break;
    case 'error':
      toast(m.message || '错误');
      break;
  }
}

function joinRoomById(roomId, rName) {
  if (!ws || ws.readyState !== 1) { toast('连接已断开'); return; }
  roomName = rName;
  wsSend({ type: 'join', room: roomId, id: myId, nickname: myNick });
}

function enterRoom() {
  $('#noRoom').classList.add('hidden');
  $('#inRoom').classList.remove('hidden');
  $('#peerBar').classList.remove('hidden');
  $('#controls').classList.remove('hidden');
  $('#currentRoom').textContent = roomName;
  $('#selfName').textContent = myNick + '（我）';
  $('#quitBtn').classList.remove('hidden');
  $('#leaveBtn').classList.add('hidden');
  renderSidebar();
}

function showNoRoom() {
  $('#noRoom').classList.remove('hidden');
  $('#inRoom').classList.add('hidden');
  $('#peerBar').classList.add('hidden');
  $('#controls').classList.add('hidden');
  $('#currentRoom').textContent = '未加入房间';
  $('#quitBtn').classList.add('hidden');
  $('#leaveBtn').classList.remove('hidden');
  renderSidebar();
}

function clearRoomPeers() {
  if (sharing) stopShare();
  for (const pid in pcs) { try { pcs[pid].close(); } catch {} }
  Object.keys(pcs).forEach(removePeer);
}

function leaveToLobby() {
  wsSend({ type: 'leave-room' });
}

function disconnectAll() {
  clearRoomPeers();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  connected = false; room = ''; roomName = '';
  $('#main').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  setLobbyMsg('');
}

// ---- 初始化 ----
(async function init() {
  try {
    myId = await getMachineId();
  } catch (e) {
    myId = 'ERR-' + hashHex(uuid()).slice(0, 12).toUpperCase();
  }
  $('#machineId').textContent = myId;

  $('#serverHost').value = localStorage.getItem('sc_host') || 'localhost:1454';
  $('#wssCheck').checked = localStorage.getItem('sc_wss') === '1';
  $('#nickInput').value = localStorage.getItem('sc_nick') || '';

  // 隐藏 splash，显示 app
  $('#splash').style.opacity = '0';
  setTimeout(() => {
    $('#splash').classList.add('hidden');
    $('#app').classList.remove('hidden');
  }, 300);

  $('#copyIdBtn').onclick = () => {
    navigator.clipboard?.writeText(myId).then(() => {
      const b = $('#copyIdBtn'); const t = b.textContent; b.textContent = '已复制'; setTimeout(() => (b.textContent = t), 1200);
    });
  };
  $('#connectBtn').onclick = connectServer;
  $('#leaveBtn').onclick = disconnectAll;
  $('#quitBtn').onclick = leaveToLobby;

  $('#micBtn').onclick = () => {
    micEnabled = !micEnabled;
    if (localMicTrack) localMicTrack.enabled = micEnabled;
    const b = $('#micBtn');
    b.classList.toggle('btn-success', micEnabled);
    b.classList.toggle('btn-error', !micEnabled);
    b.querySelector('.t').textContent = micEnabled ? '麦克风开' : '已静音';
    wsSend({ type: 'share-state', sharing, muted: !micEnabled });
  };
  $('#shareBtn').onclick = () => { sharing ? stopShare() : startShare(); };

  // 降噪下拉
  $('#noiseBtn').onclick = (e) => {
    e.stopPropagation();
    $('#noiseDropdown').classList.toggle('hidden');
  };
  document.addEventListener('click', () => $('#noiseDropdown').classList.add('hidden'));
  document.querySelectorAll('.noise-opt').forEach((opt) => {
    opt.onclick = (e) => {
      e.stopPropagation();
      const mode = opt.dataset.mode;
      $('#noiseDropdown').classList.add('hidden');
      applyNoiseMode(mode).then(() => {
        const names = { none: '已关闭降噪', rnnoise: '已启用 RNNoise 降噪', webrtc: '已启用 WebRTC ANS' };
        toast(names[mode] || '');
      }).catch((err) => toast('降噪切换失败：' + err.message));
    };
  });
  // 初始化降噪按钮状态
  (function initNoiseUI() {
    document.querySelectorAll('.noise-opt').forEach((el) => {
      el.classList.toggle('active', el.dataset.mode === noiseMode);
    });
    const labels = { none: '降噪', rnnoise: 'RNNoise', webrtc: 'ANS' };
    const nbtn = $('#noiseBtn');
    if (noiseMode !== 'none') { nbtn.classList.remove('btn-ghost'); nbtn.classList.add('btn-primary'); }
    nbtn.querySelector('.t').textContent = labels[noiseMode] || '降噪';
  })();

  $('#resolutionSelect').onchange = () => {
    shareResolution = parseInt($('#resolutionSelect').value);
    if (sharing) { toast('分辨率将在下次共享时生效'); updateSenderParams(); }
  };
  $('#framerateSelect').onchange = () => {
    shareFramerate = parseInt($('#framerateSelect').value);
    if (sharing) updateSenderParams();
  };

  // 麦克风设备选择
  $('#micDevice').onchange = () => {
    const devId = $('#micDevice').value;
    if (devId) {
      ensureMic(devId).then((ok) => {
        toast(ok ? '麦克风已切换' : '切换麦克风失败');
      });
    }
  };
  // 设备变更监听（插拔耳机等）
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { enumerateMicDevices(); });
  }

  // 点击 modal backdrop 不关闭等待框（spinner 状态）
  $('.sc-modal-backdrop').onclick = () => { if (!$('#modalIcon').querySelector('.sc-modal-spinner')) hideModal(); };

  console.log(window.__TAURI__ ? '运行于 Tauri 桌面端' : '运行于浏览器（备用模式）');
})();
