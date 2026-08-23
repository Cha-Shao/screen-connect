/* screen-connect 客户端引擎 v3（React 版）
 * 由原 app.js（原生 DOM 版）移植：WebRTC / 信令 / 降噪 / ASR / 说话检测逻辑 1:1 保留，
 * 只是把「查 DOM、改 class」替换为「更新快照并通知订阅者」。
 * React 组件通过 engine.subscribe(fn) 订阅快照，媒体元素通过 register* 注册给引擎操作。
 */

// ---- 类型 ----
export type NoiseMode = "none" | "rnnoise"

export interface MicDevice {
  deviceId: string
  label: string
}

export interface RoomDef {
  id: string
  name: string
  desc?: string
  asr?: boolean
}

export interface UserInfo {
  id: string
  nickname: string
  roomId?: string
  talking?: boolean
}

export interface PeerView {
  nickname: string
  sharing: boolean
  muted: boolean
  playing: boolean
  pinned: boolean
}

export interface PeerState {
  sharing?: boolean
  muted?: boolean
  playing?: boolean
  pinned?: boolean
}

export interface AsrInfo {
  enabled: boolean
  mode: string
  ready: boolean
}

export interface AsrLine {
  t: number
  kind: "sys" | "user"
  nickname?: string
  text: string
}

export interface ModalAction {
  text: string
  cancel?: boolean
  onClick?: () => void
}

export interface ModalState {
  icon?: string
  title?: string
  body?: string
  spinner?: boolean
  actions: ModalAction[]
}

export interface InviteInfo {
  key: string
  from: string
  fromNick: string
  roomId: string
  roomName: string
  ts: number
}

export interface Snapshot {
  ready: boolean
  connected: boolean
  myId: string
  myNick: string
  room: string
  roomName: string
  lobbyMsg: string
  serverHost: string
  wssChecked: boolean
  nick: string
  micEnabled: boolean
  deafen: boolean
  micDevices: MicDevice[]
  micDeviceId: string
  noiseMode: NoiseMode
  sharing: boolean
  shareResolution: number
  shareFramerate: number
  roomDefs: RoomDef[]
  allUsers: UserInfo[]
  talkingSet: Set<string>
  peers: Record<string, PeerView>
  asrInfo: AsrInfo | null
  asrActive: boolean
  asrActiveMode: string
  asrLines: AsrLine[]
  asrLogVisible: boolean
  roomAsr: Record<string, boolean>
  modal: ModalState | null
  toastMsg: string
  invites: InviteInfo[]
  shareCount: number
  pinCount: number
}

interface SignalData {
  type?: string
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface ServerMsg {
  type: string
  [key: string]: any
}

interface RnnoisePipeline {
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  dest: MediaStreamAudioDestinationNode
}

interface AsrStream {
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  script: ScriptProcessorNode
  silent: GainNode
}

interface TalkDetect {
  ctx: AudioContext
  src: MediaStreamAudioSourceNode
  ana: AnalyserNode
  buf: Float32Array
  timer: number
}

interface PeerEls {
  audio?: HTMLAudioElement
  video?: HTMLVideoElement
}

// ---- 工具 ----
function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
function hashHex(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let h2 = 0xcbf29ce4
  for (let i = str.length - 1; i >= 0; i--) {
    h2 ^= str.charCodeAt(i)
    h2 = Math.imul(h2, 0x01000193)
  }
  return (
    (h >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  )
}
function formatId(raw: string): string {
  const hex = String(raw)
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase()
    .slice(0, 16)
  return (hex || "0000000000000000").replace(/(.{4})/g, "$1-").replace(/-$/, "")
}
export function fmtHm(ts?: number): string {
  const d = new Date(ts || Date.now())
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  )
}
function fmtFileStamp(ts?: number): string {
  const d = new Date(ts || Date.now())
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    d.getFullYear() +
    "-" +
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    "_" +
    p(d.getHours()) +
    "-" +
    p(d.getMinutes()) +
    "-" +
    p(d.getSeconds())
  )
}
/** 把 unknown 的 catch 值转成可展示的字符串 */
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---- Tauri 桥 ----
function tauriInvoke(cmd: string, args?: unknown): Promise<unknown> {
  const t = window.__TAURI__
  if (t && t.core && typeof t.core.invoke === "function")
    return t.core.invoke(cmd, args)
  if (t && typeof t.invoke === "function") return t.invoke(cmd, args)
  if (
    window.__TAURI_INTERNALS__ &&
    typeof window.__TAURI_INTERNALS__.invoke === "function"
  )
    return window.__TAURI_INTERNALS__.invoke(cmd, args)
  throw new Error("tauri invoke 不可用")
}
async function waitTauri(maxMs = 2000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const t = window.__TAURI__
    if (
      (t && t.core && typeof t.core.invoke === "function") ||
      (t && typeof t.invoke === "function") ||
      (window.__TAURI_INTERNALS__ &&
        typeof window.__TAURI_INTERNALS__.invoke === "function")
    )
      return true
    await new Promise((r) => setTimeout(r, 60))
  }
  return false
}

// ---- 常量 ----
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:www.elfmc.com:3478" },
  { urls: "turn:www.elfmc.com:3478", username: "elfmcapp", credential: "123456" },
  { urls: "turn:www.elfmc.com:3478?transport=tcp", username: "elfmcapp", credential: "123456" },
]
const TALK_RMS_TH = 0.02
const TALK_START_FRAMES = 2
const TALK_STOP_FRAMES = 5
export const ENGINE_LABELS: Record<string, string> = {
  "local-whisper": "（本地Whisper）",
  "local-vosk": "（本地Vosk）",
  "aliyun-bailian": "（阿里云）",
}
export const ENGINE_NAMES: Record<string, string> = {
  "local-whisper": "Whisper",
  "local-vosk": "Vosk",
  "aliyun-bailian": "阿里云",
}

function defaultSnapshot(): Snapshot {
  return {
    ready: false,
    connected: false,
    myId: "",
    myNick: "",
    room: "",
    roomName: "",
    lobbyMsg: "",
    serverHost: localStorage.getItem("sc_host") || "localhost:1454",
    wssChecked: localStorage.getItem("sc_wss") === "1",
    nick: localStorage.getItem("sc_nick") || "",
    micEnabled: true,
    deafen: false,
    micDevices: [],
    micDeviceId: "",
    noiseMode: localStorage.getItem("sc_noise_mode") === "rnnoise" ? "rnnoise" : "none",
    sharing: false,
    shareResolution: 1080,
    shareFramerate: 60,
    roomDefs: [],
    allUsers: [],
    talkingSet: new Set<string>(),
    peers: {},
    asrInfo: null,
    asrActive: false,
    asrActiveMode: "local-whisper",
    asrLines: [],
    asrLogVisible: false,
    roomAsr: {},
    modal: null,
    toastMsg: "",
    invites: [],
    shareCount: 0,
    pinCount: 0,
  }
}

class Engine {
  listeners = new Set<(s: Snapshot) => void>()
  snapshot: Snapshot = defaultSnapshot()
  initialized = false

  // ---- 内部状态（不进快照） ----
  RTC_CONFIG: RTCConfiguration = { iceServers: DEFAULT_ICE.slice() }
  ws: WebSocket | null = null
  myId = ""
  myNick = ""
  room = ""
  roomName = ""
  localMic: MediaStream | null = null
  localMicTrack: MediaStreamTrack | null = null
  micEnabled = true
  deafen = false
  micEnabledBeforeDeafen = true
  screenStream: MediaStream | null = null
  screenTrack: MediaStreamTrack | null = null
  sharing = false
  noiseMode: NoiseMode = this.snapshot.noiseMode
  rawMic: MediaStream | null = null
  rnnoiseCtx: AudioContext | null = null
  rnnoiseWasmModule: WebAssembly.Module | null = null
  rnnoisePipeline: RnnoisePipeline | null = null
  rnnoiseWatchdog: number | null = null
  asrActive = false
  asrActiveMode = "local-whisper"
  asrInfo: AsrInfo | null = null
  asrLines: AsrLine[] = []
  asrLogVisible = false
  asrStream: AsrStream | null = null
  roomAsrMap: Record<string, boolean> = {}
  talkDetect: TalkDetect | null = null
  talkingLocal = false
  talkHigh = 0
  talkLow = 0
  audioCtx: AudioContext | null = null
  toastTimer: number | null = null
  _pendingInvite: { uid: string; uname: string } | null = null

  // ---- WebRTC 内部表 ----
  pcs: Record<string, RTCPeerConnection> = {}
  audioSenders: Record<string, RTCRtpSender | null> = {}
  screenSenders: Record<string, RTCRtpSender | null> = {}
  negotiator: Record<string, { makingOffer: boolean; ignoreOffer: boolean }> = {}
  peerStream: Record<string, MediaStream> = {}
  peerNick: Record<string, string> = {}
  peerState: Record<string, PeerState> = {}
  peerVolumes: Record<string, number> = {}
  _peersView: Record<string, PeerView> = {}

  // ---- 元素注册表（React 组件把媒体元素交给引擎操作） ----
  els: {
    selfVideo: HTMLVideoElement | null
    peer: Record<string, PeerEls>
    pin: Record<string, HTMLVideoElement>
  } = { selfVideo: null, peer: {}, pin: {} }

  // ================= 快照 / 订阅 =================
  set(partial: Partial<Snapshot>) {
    this.snapshot = Object.assign({}, this.snapshot, partial)
    for (const l of this.listeners) l(this.snapshot)
  }
  subscribe(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn)
    fn(this.snapshot)
    return () => this.listeners.delete(fn)
  }
  /** 从 peerState + peerNick 重建 peers 视图 */
  syncPeers(): Record<string, PeerView> {
    const v: Record<string, PeerView> = {}
    for (const id of Object.keys(this.peerState)) {
      const st = this.peerState[id]
      v[id] = {
        nickname: this.peerNick[id] || id.slice(0, 11),
        sharing: !!st.sharing,
        muted: !!st.muted,
        playing: !!st.playing,
        pinned: !!st.pinned,
      }
    }
    this._peersView = v
    return v
  }

  // ================= 提示音 =================
  playSound(type: "join" | "leave") {
    try {
      if (!this.audioCtx)
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (this.audioCtx.state === "suspended") this.audioCtx.resume()
      const notes =
        type === "join" ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25]
      notes.forEach((freq, i) => {
        const osc = this.audioCtx!.createOscillator()
        const gain = this.audioCtx!.createGain()
        osc.type = "sine"
        osc.frequency.value = freq
        osc.connect(gain)
        gain.connect(this.audioCtx!.destination)
        const t = this.audioCtx!.currentTime + i * 0.1
        gain.gain.setValueAtTime(0, t)
        gain.gain.linearRampToValueAtTime(0.15, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09)
        osc.start(t)
        osc.stop(t + 0.1)
      })
    } catch (e) {
      // 提示音失败静默
    }
  }

  // ================= Modal / Toast =================
  showModal(opts: {
    icon?: string
    title?: string
    body?: string
    spinner?: boolean
    actions?: ModalAction[]
  }) {
    const { icon = "", title = "", body = "", spinner = false, actions = [] } = opts
    this.set({ modal: { icon, title, body, spinner, actions } })
  }
  hideModal() {
    this.set({ modal: null })
  }
  toast(msg: string) {
    this.set({ toastMsg: msg })
    clearTimeout(this.toastTimer!)
    this.toastTimer = window.setTimeout(() => this.set({ toastMsg: "" }), 2400)
  }
  setLobbyMsg(t: string) {
    this.set({ lobbyMsg: t || "" })
  }

  // ================= 信令 =================
  wsSend(obj: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj))
  }
  signal(to: string, data: unknown) {
    this.wsSend({ type: "signal", to, data })
  }
  buildWsUrl(): string {
    let v = this.snapshot.serverHost.trim()
    const wss = this.snapshot.wssChecked
    if (!v) return ""
    if (/^wss?:\/\//i.test(v)) return v
    v = v.replace(/^https?:\/\//i, "").replace(/\/+$/, "")
    if (!/:\d/.test(v.split("/")[0])) {
      const idx = v.indexOf("/")
      v = idx >= 0 ? v.slice(0, idx) + ":1454" + v.slice(idx) : v + ":1454"
    }
    const path = v.endsWith("/ws") ? "" : "/ws"
    return (wss ? "wss://" : "ws://") + v + path
  }
  connectWs(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(url)
      sock.onopen = () => resolve(sock)
      sock.onerror = () =>
        reject(new Error("无法连接服务器，请检查地址/网络/防火墙"))
      sock.onclose = () => {}
    })
  }

  // ================= 表单 =================
  setForm(patch: Partial<Snapshot>) {
    this.set(patch)
  }

  // ================= WebRTC =================
  /** 把某人的远端音频接到播放元素并开始播放（自动播放策略可能拦截，静默失败，等用户手势后由 resumeRemoteAudio 重试） */
  attachRemoteAudio(peerId: string) {
    const a = this.els.peer[peerId] && this.els.peer[peerId].audio
    const stream = this.peerStream[peerId]
    if (!a || !stream) return
    a.srcObject = stream
    if (this.peerVolumes[peerId] != null) a.volume = this.peerVolumes[peerId] / 100
    a.muted = this.deafen
    const p = a.play()
    if (p)
      p.catch((e) => {
        if (e && e.name === "NotAllowedError") {
          console.warn(
            "[audio] 远端音频被浏览器自动播放策略拦截（" +
              (this.peerNick[peerId] || peerId) +
              "），点击页面任意位置后会自动恢复",
          )
        }
      })
  }

  /** 恢复所有被自动播放策略拦截的远端音频（必须在用户手势回调里调用） */
  resumeRemoteAudio() {
    for (const pid in this.els.peer) {
      const a = this.els.peer[pid].audio
      if (a && a.srcObject && a.paused) {
        const p = a.play()
        if (p) p.catch(() => {})
      }
    }
  }

  ensurePC(peerId: string): RTCPeerConnection {
    if (this.pcs[peerId]) return this.pcs[peerId]
    const pc = new RTCPeerConnection(this.RTC_CONFIG)
    this.pcs[peerId] = pc
    this.negotiator[peerId] = { makingOffer: false, ignoreOffer: false }

    const audioT = pc.addTransceiver("audio", { direction: "sendrecv" })
    this.audioSenders[peerId] = audioT.sender
    if (this.localMicTrack) audioT.sender.replaceTrack(this.localMicTrack)

    if (this.screenTrack && this.screenStream) {
      try {
        const sender = pc.addTrack(this.screenTrack, this.screenStream)
        this.screenSenders[peerId] = sender
        this.boostSender(sender)
      } catch (e) {
        console.warn("addTrack on new PC", peerId, e)
      }
    }

    pc.ontrack = (e) => {
      const stream = (this.peerStream[peerId] = this.peerStream[peerId] || new MediaStream())
      if (e.track.kind === "video") {
        for (const t of stream.getVideoTracks()) stream.removeTrack(t)
      }
      stream.addTrack(e.track)
      if (e.track.kind === "audio") {
        this.attachRemoteAudio(peerId)
      } else {
        e.track.onunmute = () => {
          this.syncPeerVideo(peerId)
        }
        e.track.onmute = () => {
          if (this.peerState[peerId] && this.peerState[peerId].playing) {
            const el = this.els.peer[peerId] && this.els.peer[peerId].video
            if (el) el.srcObject = null
          }
        }
        e.track.onended = () => {
          stream.removeTrack(e.track)
          if (this.peerState[peerId] && this.peerState[peerId].playing) {
            const el = this.els.peer[peerId] && this.els.peer[peerId].video
            if (el) el.srcObject = null
          }
        }
        this.syncPeerVideo(peerId)
      }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(peerId, { type: "candidate", candidate: e.candidate })
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === "failed" || st === "disconnected") {
        try {
          pc.restartIce && pc.restartIce()
        } catch {}
      }
      if (st === "closed") this.removePeer(peerId)
    }
    return pc
  }

  getShareBitrate(): number {
    const r = this.snapshot.shareResolution
    const f = this.snapshot.shareFramerate
    if (r === 1080) return f === 60 ? 6_000_000 : 4_000_000
    return f === 60 ? 3_500_000 : 2_000_000
  }
  async boostSender(sender: RTCRtpSender) {
    try {
      const p = sender.getParameters()
      if (!p.encodings || !p.encodings.length) p.encodings = [{}]
      p.encodings[0].maxBitrate = this.getShareBitrate()
      p.encodings[0].maxFramerate = this.snapshot.shareFramerate
      p.degradationPreference = "maintain-framerate"
      await sender.setParameters(p)
    } catch (e) {
      // 参数调整失败静默
    }
  }
  async makeOffer(peerId: string) {
    const pc = this.ensurePC(peerId)
    if (pc.signalingState !== "stable") return
    try {
      this.negotiator[peerId].makingOffer = true
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.signal(peerId, { type: "offer", sdp: offer })
    } catch (e) {
      console.warn("makeOffer failed", peerId, e)
    } finally {
      this.negotiator[peerId].makingOffer = false
    }
  }
  async renegotiate(peerId: string) {
    const pc = this.pcs[peerId]
    if (!pc || pc.signalingState !== "stable") return
    try {
      this.negotiator[peerId].makingOffer = true
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.signal(peerId, { type: "offer", sdp: offer })
    } catch (e) {
      console.warn("renegotiate failed", peerId, e)
    } finally {
      this.negotiator[peerId].makingOffer = false
    }
  }
  async onSignal(from: string, data: SignalData) {
    const pc = this.ensurePC(from)
    const neg = this.negotiator[from]
    try {
      if (data.type === "offer") {
        const collision = neg.makingOffer || pc.signalingState !== "stable"
        const polite = from < this.myId
        neg.ignoreOffer = !polite && collision
        if (neg.ignoreOffer) return
        if (collision) await pc.setLocalDescription({ type: "rollback" })
        await pc.setRemoteDescription(data.sdp!)
        const ans = await pc.createAnswer()
        await pc.setLocalDescription(ans)
        this.signal(from, { type: "answer", sdp: ans })
      } else if (data.type === "answer") {
        await pc.setRemoteDescription(data.sdp!)
      } else if (data.type === "candidate") {
        try {
          await pc.addIceCandidate(data.candidate!)
        } catch {}
      }
    } catch (e) {
      console.warn("信令处理失败", from, e)
    }
  }

  // ================= 房间成员 =================
  ensurePeer(peerId: string) {
    if (this.peerState[peerId]) return
    this.peerState[peerId] = {}
    this.peerStream[peerId] = this.peerStream[peerId] || new MediaStream()
    this.syncPeers()
    this.set({
      peers: this._peersView,
      shareCount: this.shareCountOf(),
    })
  }
  shareCountOf(): number {
    return Object.values(this.peerState).filter((s) => s.sharing).length
  }
  refreshPeerTags(peerId: string) {
    this.syncPeers()
    this.set({ peers: this._peersView, shareCount: this.shareCountOf() })
  }
  togglePlay(peerId: string) {
    const st = (this.peerState[peerId] = this.peerState[peerId] || {})
    st.playing = !st.playing
    this.syncPeerVideo(peerId)
    this.refreshPeerTags(peerId)
  }
  togglePin(peerId: string) {
    const st = (this.peerState[peerId] = this.peerState[peerId] || {})
    st.pinned = !st.pinned
    this.syncPeerVideo(peerId)
    this.refreshPeerTags(peerId)
    this.set({ pinCount: this.pinCountOf() })
  }
  pinCountOf(): number {
    return Object.values(this.peerState).filter((s) => s.pinned).length
  }
  syncPeerVideo(peerId: string) {
    const stream = this.peerStream[peerId]
    const st = this.peerState[peerId] || {}
    if (st.playing && this.els.peer[peerId] && this.els.peer[peerId].video) {
      const el = this.els.peer[peerId].video
      el.srcObject = stream
      el.play().catch(() => {})
    }
    if (st.pinned && this.els.pin[peerId]) {
      this.els.pin[peerId].srcObject = stream
      this.els.pin[peerId].play().catch(() => {})
    }
  }
  setPeerVolume(peerId: string, v: number) {
    this.peerVolumes[peerId] = v
    const a = this.els.peer[peerId] && this.els.peer[peerId].audio
    if (a) a.volume = v / 100
  }
  /** 屏幕全屏：把某人的画面元素全屏（再次调用退出全屏） */
  async togglePeerFullscreen(peerId: string) {
    const v: HTMLVideoElement | HTMLAudioElement | null =
      peerId === this.myId
        ? this.els.selfVideo
        : (this.els.peer[peerId] && this.els.peer[peerId].video) || null
    if (!v) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else if (v.requestFullscreen) {
        await v.requestFullscreen()
      }
    } catch (e) {
      console.warn("全屏失败", e)
    }
  }
  removePeer(peerId: string) {
    const pc = this.pcs[peerId]
    if (pc) {
      try {
        pc.close()
      } catch {}
      delete this.pcs[peerId]
    }
    delete this.screenSenders[peerId]
    delete this.audioSenders[peerId]
    delete this.negotiator[peerId]
    delete this.els.peer[peerId]
    delete this.els.pin[peerId]
    delete this.peerStream[peerId]
    delete this.peerNick[peerId]
    delete this.peerState[peerId]
    delete this.peerVolumes[peerId]
    this.syncPeers()
    this.set({
      peers: this._peersView,
      pinCount: this.pinCountOf(),
      shareCount: this.shareCountOf(),
    })
  }

  // ================= 媒体采集 =================
  async enumerateMicDevices(): Promise<MediaDeviceInfo[]> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const mics = devices.filter((d) => d.kind === "audioinput")
      const list: MicDevice[] = mics.map((m, i) => ({
        deviceId: m.deviceId,
        label: m.label || "麦克风 " + (i + 1),
      }))
      this.set({ micDevices: list })
      return mics
    } catch (e) {
      return []
    }
  }

  async ensureMic(deviceId?: string): Promise<boolean> {
    const constraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    }
    if (deviceId) constraints.deviceId = { exact: deviceId }
    try {
      const newMic = await navigator.mediaDevices.getUserMedia({
        audio: constraints,
      })
      const newTrack = newMic.getAudioTracks()[0]
      newTrack.enabled = this.micEnabled

      if (this.rawMic) {
        this.rawMic.getTracks().forEach((t) => t.stop())
      }
      this.rawMic = newMic
      this.localMic = newMic
      this.localMicTrack = newTrack

      await this.applyNoiseMode(this.noiseMode, deviceId)

      if (deviceId) this.set({ micDeviceId: deviceId })
      else this.enumerateMicDevices()
      return true
    } catch (e) {
      console.warn("ensureMic 失败", e)
      return false
    }
  }

  /** 清理降噪管线（worklet + 输出轨道），释放 wasm 状态（newState 只能分配一次） */
  teardownNoisePipeline() {
    if (this.rnnoiseWatchdog) {
      clearInterval(this.rnnoiseWatchdog)
      this.rnnoiseWatchdog = null
    }
    if (this.rnnoisePipeline) {
      try {
        this.rnnoisePipeline.source.disconnect()
        this.rnnoisePipeline.node.disconnect()
        this.rnnoisePipeline.dest.disconnect()
        this.rnnoisePipeline.dest.stream.getTracks().forEach((t) => {
          try {
            t.stop()
          } catch {}
        })
        // 释放 worklet 里的 wasm 状态：newState 总共只能分配一个（wasm 内存只有 320KB），
        // 不释放的话下次开启降噪会拿到 NULL 状态，pipe 立即越界崩溃
        try {
          this.rnnoisePipeline.node.port.postMessage(false)
        } catch (e) {}
      } catch (e) {}
      this.rnnoisePipeline = null
    }
  }

  /** 释放本地麦克风（原始轨道 + 降噪管线），所有发送器退回静音，说话检测/转写一并停止 */
  stopMic() {
    this.teardownNoisePipeline()
    if (this.rawMic) {
      this.rawMic.getTracks().forEach((t) => {
        try {
          t.stop()
        } catch {}
      })
      this.rawMic = null
    }
    this.localMic = null
    this.localMicTrack = null
    // 已有发送器改为发送空轨道（等同静音）
    for (const pid in this.audioSenders) {
      if (this.audioSenders[pid]) {
        try {
          this.audioSenders[pid]!.replaceTrack(null)
        } catch (e) {}
      }
    }
    this.stopTalkDetect()
    this.stopAsrStream()
  }

  /** 进入房间（或取消静音）后按需获取麦克风；获取失败则提示并把麦置为关闭 */
  async startMicIfNeeded() {
    if (!this.room) return
    if (!this.localMicTrack) {
      const ok = await this.ensureMic()
      if (!ok) {
        if (this.micEnabled) {
          this.micEnabled = false
          this.wsSend({ type: "share-state", sharing: this.sharing, muted: true })
          this.set({ micEnabled: false })
          this.toast("无法访问麦克风：请检查系统麦克风权限后重试")
        }
        return
      }
    }
    if (this.micEnabled && this.room) this.startTalkDetect()
  }

  async applyNoiseMode(mode: NoiseMode, micDeviceId?: string) {
    this.noiseMode = mode
    localStorage.setItem("sc_noise_mode", mode)
    this.set({ noiseMode: mode })

    if (!this.rawMic) return

    // 清理旧管线：断开全部节点并停掉旧轨道，避免反复切换后残留"静音轨道/挂起状态"
    this.teardownNoisePipeline()

    /** rnnoise 异常时自动退回原始麦克风 */
    const fallbackToRaw = (why: string) => {
      if (this.noiseMode !== "rnnoise") return
      console.warn("[降噪] " + why + "，自动切换为原始麦克风")
      this.toast("降噪异常，已自动切换原始麦克风")
      this.applyNoiseMode("none")
    }

    let newTrack: MediaStreamTrack
    let builtNode: AudioWorkletNode | null = null
    if (mode === "rnnoise") {
      try {
        if (!this.rnnoiseCtx)
          this.rnnoiseCtx = new (window.AudioContext || window.webkitAudioContext)()
        if (this.rnnoiseCtx.state === "suspended") await this.rnnoiseCtx.resume()
        if (!this.rnnoiseWasmModule) {
          const buf = await (await fetch("rnnoise.wasm")).arrayBuffer()
          this.rnnoiseWasmModule = await WebAssembly.compile(buf)
        }
        await this.rnnoiseCtx.audioWorklet.addModule("rnnoise.worklet.js")
        const source = this.rnnoiseCtx.createMediaStreamSource(this.rawMic)
        const node = new AudioWorkletNode(this.rnnoiseCtx, "rnnoise", {
          channelCountMode: "explicit",
          channelCount: 1,
          channelInterpretation: "speakers",
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { module: this.rnnoiseWasmModule },
        })
        builtNode = node
        node.port.onmessage = ({ data }) => {
          if (data && data.crash && this.rnnoisePipeline && this.rnnoisePipeline.node === node)
            fallbackToRaw("rnnoise 处理异常（wasm 越界）")
        }
        const dest = this.rnnoiseCtx.createMediaStreamDestination()
        source.connect(node)
        node.connect(dest)
        this.rnnoisePipeline = { source, node, dest }
        newTrack = dest.stream.getAudioTracks()[0]

        // 看门狗：rnnoise 输出静音但原始麦克风有明显声音，持续 ~2s 则自动退回
        const analRaw = this.rnnoiseCtx.createAnalyser()
        analRaw.fftSize = 1024
        const analOut = this.rnnoiseCtx.createAnalyser()
        analOut.fftSize = 1024
        source.connect(analRaw)
        node.connect(analOut)
        const bufR = new Float32Array(analRaw.fftSize)
        const bufO = new Float32Array(analOut.fftSize)
        const rmsOf = (ana: AnalyserNode, b: Float32Array<ArrayBuffer>) => {
          ana.getFloatTimeDomainData(b)
          let s = 0
          for (let i = 0; i < b.length; i++) s += b[i] * b[i]
          return Math.sqrt(s / b.length)
        }
        let silentTicks = 0
        this.rnnoiseWatchdog = window.setInterval(() => {
          const r = rmsOf(analRaw, bufR)
          const o = rmsOf(analOut, bufO)
          if (o < 0.006 && r > 0.04) {
            if (++silentTicks >= 4) fallbackToRaw("rnnoise 输出静音但原始麦克风有声（持续约 2s）")
          } else {
            silentTicks = 0
          }
        }, 500)
      } catch (e) {
        console.warn("[降噪] RNNoise 初始化失败，已退回原始麦克风:", msgOf(e))
        if (builtNode) {
          try {
            builtNode.port.postMessage(false)
          } catch (err) {}
        }
        this.rnnoisePipeline = null
        newTrack = this.rawMic.getAudioTracks()[0]
      }
    } else {
      newTrack = this.rawMic.getAudioTracks()[0]
    }

    this.localMicTrack = newTrack
    for (const pid in this.audioSenders) {
      if (this.audioSenders[pid]) {
        try {
          await this.audioSenders[pid]!.replaceTrack(newTrack)
        } catch (e) {}
      }
    }
    // 降噪切换后麦克风轨道变了，转写上传链路与说话检测需重建
    if (this.asrStream) {
      this.stopAsrStream()
      if (this.asrActive && this.room) this.startAsrStream()
    }
    if (this.talkDetect) {
      this.stopTalkDetect()
      if (this.room) this.startTalkDetect()
    }
  }

  // ================= 屏幕共享 =================
  async startShare() {
    const w = this.snapshot.shareResolution === 1080 ? 1920 : 1280
    const h = this.snapshot.shareResolution === 1080 ? 1080 : 720
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: this.snapshot.shareFramerate, max: this.snapshot.shareFramerate },
        },
        audio: false,
      })
      this.screenTrack = this.screenStream.getVideoTracks()[0]
      this.screenTrack.onended = () => this.stopShare()
      this.sharing = true
      if (this.els.selfVideo) this.els.selfVideo.srcObject = this.screenStream
      for (const pid in this.pcs) {
        try {
          const sender = this.pcs[pid].addTrack(this.screenTrack, this.screenStream)
          this.screenSenders[pid] = sender
          this.boostSender(sender)
        } catch (e) {
          console.warn("addTrack", pid, e)
        }
      }
      for (const pid in this.pcs) this.renegotiate(pid)
      this.set({ sharing: true })
      this.wsSend({ type: "share-state", sharing: true, muted: !this.micEnabled })
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") this.toast("共享失败：" + msgOf(e))
    }
  }
  stopShare() {
    if (this.screenTrack) {
      try {
        this.screenTrack.stop()
      } catch {}
    }
    this.screenTrack = null
    this.screenStream = null
    this.sharing = false
    if (this.els.selfVideo) this.els.selfVideo.srcObject = null
    for (const pid in this.screenSenders) {
      if (this.screenSenders[pid] && this.pcs[pid]) {
        try {
          this.pcs[pid].removeTrack(this.screenSenders[pid]!)
        } catch (e) {}
      }
    }
    Object.keys(this.screenSenders).forEach((k) => delete this.screenSenders[k])
    for (const pid in this.pcs) this.renegotiate(pid)
    this.set({ sharing: false })
    this.wsSend({ type: "share-state", sharing: false, muted: !this.micEnabled })
  }
  async updateSenderParams() {
    for (const pid in this.screenSenders) {
      if (this.screenSenders[pid]) {
        try {
          const p = this.screenSenders[pid]!.getParameters()
          if (!p.encodings || !p.encodings.length) p.encodings = [{}]
          p.encodings[0].maxBitrate = this.getShareBitrate()
          p.encodings[0].maxFramerate = this.snapshot.shareFramerate
          p.degradationPreference = "maintain-framerate"
          await this.screenSenders[pid]!.setParameters(p)
        } catch (e) {}
      }
    }
  }

  // ================= ASR =================
  asrLineText(l: AsrLine): string {
    return l.kind === "sys"
      ? l.text + " " + fmtHm(l.t)
      : (l.nickname || "?") + "：" + l.text + " " + fmtHm(l.t)
  }
  showAsrLog() {
    this.asrLogVisible = true
    this.set({ asrLogVisible: true })
  }
  hideAsrLog() {
    this.asrLogVisible = false
    this.set({ asrLogVisible: false })
  }
  resetAsrLocal() {
    this.asrActive = false
    this.asrActiveMode = "local-whisper"
    this.asrLines = []
    this.stopAsrStream()
    this.asrLogVisible = false
    this.set({
      asrActive: false,
      asrActiveMode: "local-whisper",
      asrLines: [],
      asrLogVisible: false,
    })
  }
  async downloadAsrLog() {
    const lines = this.asrLines.map((l) => this.asrLineText(l))
    const content = lines.join("\n")
    const safe = (this.roomName || this.room || "房间").replace(/[\\/:*?"<>|]/g, "_")
    const suggested = "转写日志-" + safe + "-" + fmtFileStamp(Date.now()) + ".txt"
    // Tauri 桌面端：弹系统「另存为」对话框
    if (await waitTauri()) {
      try {
        const saved = await tauriInvoke("save_asr_log", {
          content,
          suggestedName: suggested,
        })
        if (saved) this.toast("转写日志已保存到 " + String(saved))
        return
      } catch (e) {
        console.warn("原生保存对话框失败，回退浏览器下载", e)
      }
    }
    // 浏览器模式：普通下载
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = suggested
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // ---- 麦克风音频上传（重采样到 16k 单声道 Int16，二进制帧） ----
  async startAsrStream() {
    if (this.asrStream || !this.asrActive || !this.room) return
    if (!this.localMicTrack) {
      try {
        await this.ensureMic()
      } catch (e) {}
    }
    if (!this.localMicTrack || !this.micEnabled) return
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      if (ctx.state === "suspended") await ctx.resume()
      const source = ctx.createMediaStreamSource(new MediaStream([this.localMicTrack]))
      const script = ctx.createScriptProcessor(4096, 1, 1)
      const silent = ctx.createGain()
      silent.gain.value = 0
      const TARGET = 16000
      const ratio = ctx.sampleRate / TARGET
      const room = this.room
      let out: number[] = []
      let lastSend = 0
      script.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0)
        for (let i = 0; i < input.length; i += ratio) {
          const pos = Math.floor(i)
          const frac = i - pos
          out.push(
            pos + 1 < input.length
              ? input[pos] * (1 - frac) + input[pos + 1] * frac
              : input[pos],
          )
        }
        const now = Date.now()
        if (now - lastSend >= 250 && out.length >= 4000) {
          lastSend = now
          const take = Math.floor(out.length / 4000) * 4000
          this.sendAsrAudio(out.splice(0, take), room)
        }
      }
      source.connect(script)
      script.connect(silent)
      silent.connect(ctx.destination)
      this.asrStream = { ctx, source, script, silent }
    } catch (e) {
      console.warn("ASR 音频上传启动失败", e)
    }
  }
  stopAsrStream() {
    if (!this.asrStream) return
    try {
      this.asrStream.source.disconnect()
      this.asrStream.script.disconnect()
      this.asrStream.silent.disconnect()
      this.asrStream.ctx.close()
    } catch (e) {}
    this.asrStream = null
  }
  sendAsrAudio(samples: number[], room: string) {
    if (!this.ws || this.ws.readyState !== 1) return
    const pcm = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      let s = Math.round(samples[i] * 32767)
      if (s > 32767) s = 32767
      else if (s < -32768) s = -32768
      pcm[i] = s
    }
    const header = JSON.stringify({ type: "asr-audio", room })
    const hb = new TextEncoder().encode(header)
    const lenBuf = new ArrayBuffer(4)
    new DataView(lenBuf).setUint32(0, hb.length)
    const payload = new Uint8Array(4 + hb.length + pcm.byteLength)
    payload.set(new Uint8Array(lenBuf), 0)
    payload.set(hb, 4)
    payload.set(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
      4 + hb.length,
    )
    this.ws.send(payload.buffer)
  }

  // ================= 说话检测 =================
  startTalkDetect() {
    if (this.talkDetect || !this.localMicTrack || !this.room) return
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      if (ctx.state === "suspended") ctx.resume()
      const src = ctx.createMediaStreamSource(new MediaStream([this.localMicTrack]))
      const ana = ctx.createAnalyser()
      ana.fftSize = 1024
      src.connect(ana)
      const buf = new Float32Array(ana.fftSize)
      const self = this
      this.talkDetect = {
        ctx,
        src,
        ana,
        buf,
        timer: window.setInterval(() => {
          ana.getFloatTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
          self.updateTalking(Math.sqrt(sum / buf.length))
        }, 200),
      }
    } catch (e) {
      console.warn("说话检测启动失败", e)
    }
  }
  stopTalkDetect() {
    if (!this.talkDetect) return
    try {
      clearInterval(this.talkDetect.timer)
      this.talkDetect.src.disconnect()
      this.talkDetect.ctx.close()
    } catch (e) {}
    this.talkDetect = null
    this.talkHigh = 0
    this.talkLow = 0
    if (this.talkingLocal) {
      this.talkingLocal = false
      this.wsSend({ type: "talking", on: false })
    }
  }
  updateTalking(rms: number) {
    let on = this.talkingLocal
    if (rms >= TALK_RMS_TH) {
      this.talkHigh++
      this.talkLow = 0
      if (this.talkHigh >= TALK_START_FRAMES) on = true
    } else {
      this.talkLow++
      this.talkHigh = 0
      if (this.talkLow >= TALK_STOP_FRAMES) on = false
    }
    if (on !== this.talkingLocal) {
      this.talkingLocal = on
      this.wsSend({ type: "talking", on })
    }
  }

  // ================= 用户管理 =================
  moveUserToRoom(uid: string, targetRoomId: string, targetRoomName: string) {
    const u = this.snapshot.allUsers.find((x) => x.id === uid)
    if (!u) return
    if (uid === this.myId) {
      this.toast("不能移动自己，请点击房间名加入")
      return
    }
    this.wsSend({ type: "move-user", targetId: uid, roomId: targetRoomId })
    this.toast(`已将 ${u.nickname} 移至「${targetRoomName}」`)
  }
  inviteUser(uid: string, uname: string) {
    if (!this.room) {
      // 自己不在房间：先提示加入一个房间，加入成功后自动补发邀请
      const rooms = this.snapshot.roomDefs || []
      if (rooms.length === 0) {
        this.toast("请先加入一个房间再邀请")
        return
      }
      this._pendingInvite = { uid, uname }
      this.showModal({
        icon: "🏠",
        title: "请先加入一个房间",
        body: `要邀请 <b>${uname}</b>，需要你先加入一个房间。选择一个房间加入后会自动发出邀请：`,
        actions: [
          ...rooms.map((rd) => ({
            text: "加入「" + rd.name + "」",
            onClick: () => this.joinRoomById(rd.id, rd.name),
          })),
          {
            text: "取消",
            cancel: true,
            onClick: () => {
              this._pendingInvite = null
            },
          },
        ],
      })
      return
    }
    this.wsSend({ type: "invite", targetId: uid, roomName: this.roomName })
    this.toast(`已邀请 ${uname} 加入「${this.roomName}」`)
  }

  // ---- 收到的邀请（右下角常驻弹窗，不自动关闭） ----
  pushInvite(inv: InviteInfo) {
    const list = (this.snapshot.invites || []).concat(inv)
    // 最多同时保留 4 条，超出丢弃最旧的
    if (list.length > 4) list.splice(0, list.length - 4)
    this.set({ invites: list })
    this.playSound("join")
  }
  dismissInvite(key: string) {
    this.set({
      invites: (this.snapshot.invites || []).filter((i) => i.key !== key),
    })
  }
  acceptInvite(key: string) {
    const inv = (this.snapshot.invites || []).find((i) => i.key === key)
    if (!inv) return
    this.wsSend({ type: "invite-accept", roomId: inv.roomId })
    this.dismissInvite(key)
  }

  // ================= 流程 =================
  async connectServer() {
    const wsUrl = this.buildWsUrl()
    const host = this.snapshot.serverHost.trim()
    const nick = this.snapshot.nick.trim() || "匿名"
    if (!host) {
      this.setLobbyMsg("请填写服务器地址")
      return
    }

    this.showModal({
      spinner: true,
      title: "连接服务器中",
      body: "正在连接 " + host + "…",
    })

    let sock: WebSocket
    try {
      sock = await this.connectWs(wsUrl)
    } catch (e) {
      this.hideModal()
      this.setLobbyMsg(msgOf(e))
      return
    }
    this.ws = sock

    localStorage.setItem("sc_host", host)
    localStorage.setItem("sc_wss", this.snapshot.wssChecked ? "1" : "0")
    this.myNick = nick
    localStorage.setItem("sc_nick", nick)

    // ★ 关键：先注册 onmessage，避免丢失服务器自动下发的 room-list
    sock.onmessage = (ev) => {
      let m: ServerMsg
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      this.handleServerMsg(m)
    }
    sock.onclose = () => {
      this.set({ connected: false, invites: [] })
      this._pendingInvite = null
      this.hideModal()
      this.clearRoomPeers()
      this.resetAsrLocal()
      this.room = ""
      this.roomName = ""
      this.stopMic()
      this.set({ room: "", roomName: "" })
      this.setLobbyMsg("与服务器的连接已断开")
    }

    // 立即上报身份：让服务器登记"在线（大厅）"
    this.wsSend({ type: "identify", id: this.myId, nickname: this.myNick })

    // 只枚举设备列表（不申请权限）：麦克风等加入房间后再按需获取，
    // 避免还没进房间就在浏览器/系统里显示"正在使用麦克风"
    this.enumerateMicDevices()

    // 主动请求房间列表和用户列表（服务器也会自动下发，这里兜底）
    this.wsSend({ type: "get-rooms" })

    this.hideModal()
    this.set({
      connected: true,
      myNick: this.myNick,
      room: "",
      roomName: "",
    })
  }

  handleServerMsg(m: ServerMsg) {
    switch (m.type) {
      case "room-list":
        this.snapshot.roomDefs = m.rooms || []
        if (m.iceServers && m.iceServers.length)
          this.RTC_CONFIG.iceServers = m.iceServers
        for (const r of this.snapshot.roomDefs)
          if (typeof r.asr === "boolean") this.roomAsrMap[r.id] = r.asr
        this.set({ roomDefs: this.snapshot.roomDefs, roomAsr: this.roomAsrMap })
        break
      case "user-list":
        this.set({
          allUsers: m.users || [],
          talkingSet: new Set<string>((m.users || []).filter((u: UserInfo) => u.talking).map((u: UserInfo) => u.id)),
        })
        break
      case "talking":
        {
          const ts = new Set(this.snapshot.talkingSet)
          if (m.on) ts.add(m.id)
          else ts.delete(m.id)
          this.set({ talkingSet: ts })
        }
        break
      case "joined":
        if (this.room && this.room !== m.room) {
          this.clearRoomPeers()
          this.resetAsrLocal()
        }
        this.room = m.room
        this.myNick = m.nickname
        const rd = this.snapshot.roomDefs.find((r) => r.id === m.room)
        this.roomName = rd ? rd.name : m.room
        for (const p of m.peers || []) {
          this.peerNick[p.id] = p.nickname
          if (p.sharing) {
            this.peerState[p.id] = this.peerState[p.id] || {}
            this.peerState[p.id].sharing = true
          }
          this.ensurePeer(p.id)
        }
        for (const p of m.peers || []) this.makeOffer(p.id)
        this.enterRoom()
        // 邀请流程：加入房间成功后，自动补发之前被"请先加入房间"拦下的邀请
        if (this._pendingInvite) {
          const pi = this._pendingInvite
          this._pendingInvite = null
          this.wsSend({ type: "invite", targetId: pi.uid, roomName: this.roomName })
          this.toast(`已邀请 ${pi.uname} 加入「${this.roomName}」`)
        }
        break
      case "left-room":
        this.clearRoomPeers()
        this.resetAsrLocal()
        this.room = ""
        this.roomName = ""
        this.showNoRoom()
        break
      case "moved":
        this.toast(
          "你被移动到房间「" +
            (this.snapshot.roomDefs.find((r) => r.id === m.roomId)?.name || m.roomId) +
            "」",
        )
        break
      case "peer-joined":
        this.peerNick[m.peer.id] = m.peer.nickname
        this.ensurePeer(m.peer.id)
        this.playSound("join")
        if (this.sharing)
          this.wsSend({ type: "share-state", sharing: true, muted: !this.micEnabled })
        break
      case "signal":
        this.onSignal(m.from, m.data)
        break
      case "nickname":
        this.peerNick[m.id] = m.nickname
        this.refreshPeerTags(m.id)
        break
      case "share-state":
        this.peerState[m.id] = this.peerState[m.id] || {}
        this.peerState[m.id].sharing = m.sharing
        this.peerState[m.id].muted = m.muted
        this.refreshPeerTags(m.id)
        if (m.sharing) {
          this.syncPeerVideo(m.id)
        } else {
          if (this.peerState[m.id].playing) this.togglePlay(m.id)
          if (this.peerState[m.id].pinned) this.togglePin(m.id)
        }
        break
      case "peer-left":
        {
          const ts = new Set(this.snapshot.talkingSet)
          ts.delete(m.id)
          this.set({ talkingSet: ts })
        }
        this.removePeer(m.id)
        this.playSound("leave")
        break
      case "invite":
        // 右下角常驻弹窗（不自动关闭），由 InviteToast 组件渲染
        this.pushInvite({
          key: m.from + ":" + m.roomId + ":" + Date.now(),
          from: m.from,
          fromNick: m.fromNick,
          roomId: m.roomId,
          roomName: m.roomName || m.roomId,
          ts: Date.now(),
        })
        break
      case "asr-state":
        this.roomAsrMap[m.roomId] = m.on
        if (m.roomId === this.room) {
          this.asrActive = m.on
          if (m.on) {
            this.asrActiveMode =
              m.mode === "aliyun-bailian" || m.mode === "local-vosk"
                ? m.mode
                : "local-whisper"
            this.asrLines.push({
              t: m.startTs || Date.now(),
              kind: "sys",
              text: "语音转写开启",
            })
            this.showAsrLog()
            this.startAsrStream()
          } else {
            this.asrLines.push({
              t: m.endTs || Date.now(),
              kind: "sys",
              text: "语音转写关闭",
            })
            this.stopAsrStream()
          }
          this.set({
            asrActive: this.asrActive,
            asrActiveMode: this.asrActiveMode,
            asrLines: this.asrLines.slice(),
          })
        }
        this.set({ roomAsr: this.roomAsrMap })
        break
      case "asr-badge":
        this.roomAsrMap[m.roomId] = m.on
        this.set({ roomAsr: this.roomAsrMap })
        break
      case "asr-info":
        this.asrInfo = { enabled: !!m.enabled, mode: m.mode || "", ready: !!m.ready }
        this.set({ asrInfo: this.asrInfo })
        break
      case "asr-history":
        if (m.roomId === this.room) {
          this.asrLines = (m.lines || []).map((l: any) => ({
            t: l.t,
            kind: l.kind,
            nickname: l.nickname,
            text: l.text,
          }))
          this.showAsrLog()
          this.set({ asrLines: this.asrLines.slice() })
        }
        break
      case "asr-line":
        if (m.roomId === this.room && this.asrActive) {
          this.asrLines.push({
            t: m.t,
            kind: "user",
            nickname: m.nickname,
            text: m.text,
          })
          this.set({ asrLines: this.asrLines.slice() })
        }
        break
      case "error":
        this.toast(m.message || "错误")
        break
    }
  }

  joinRoomById(roomId: string, rName: string) {
    if (!this.ws || this.ws.readyState !== 1) {
      this.toast("连接已断开")
      return
    }
    this.roomName = rName
    this.wsSend({ type: "join", room: roomId, id: this.myId, nickname: this.myNick })
  }

  enterRoom() {
    this.set({
      room: this.room,
      roomName: this.roomName,
      myNick: this.myNick,
    })
    if (this.micEnabled) this.startMicIfNeeded()
  }

  showNoRoom() {
    // 回到大厅即释放麦克风，浏览器/系统的"正在使用麦克风"指示随之消失
    this.stopMic()
    this.set({ room: "", roomName: "" })
  }

  clearRoomPeers() {
    if (this.sharing) this.stopShare()
    for (const pid in this.pcs) {
      try {
        this.pcs[pid].close()
      } catch {}
    }
    Object.keys(this.pcs).forEach((pid) => this.removePeer(pid))
  }

  leaveToLobby() {
    this.wsSend({ type: "leave-room" })
  }

  disconnectAll() {
    this.clearRoomPeers()
    this.resetAsrLocal()
    this.stopMic()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    this.room = ""
    this.roomName = ""
    this._pendingInvite = null
    this.set({
      connected: false,
      room: "",
      roomName: "",
      lobbyMsg: "",
      invites: [],
    })
  }

  // ================= 控制栏动作 =================
  /** 设置麦克风开关，联动转写/讲话检测/远端 muted 状态 */
  setMicState(v: boolean) {
    this.micEnabled = v
    if (this.localMicTrack) this.localMicTrack.enabled = v
    this.wsSend({ type: "share-state", sharing: this.sharing, muted: !v })
    // 转写中：静音时停止上传，取消静音恢复上传
    if (!v) {
      this.stopAsrStream()
      this.stopTalkDetect()
    } else {
      if (this.asrActive && this.room) this.startAsrStream()
      if (this.room) this.startMicIfNeeded()
    }
    this.set({ micEnabled: v })
  }

  toggleMic() {
    this.resumeRemoteAudio() // 用户手势：顺带恢复被自动播放策略拦截的远端音频
    // 聋哑状态下点麦克风 = 解除聋哑并继续说话
    if (this.deafen) {
      this.deafen = false
      this.applyDeafenToAudio()
      this.set({ deafen: false })
    }
    this.setMicState(!this.micEnabled)
  }

  /** 耳机按钮：聋哑模式（自己闭麦 + 听不到别人），红色 = 已开启 */
  toggleDeafen() {
    this.resumeRemoteAudio()
    if (this.deafen) {
      // 解除聋哑：恢复之前的麦克风状态
      this.deafen = false
      this.setMicState(this.micEnabledBeforeDeafen != null ? this.micEnabledBeforeDeafen : true)
    } else {
      // 进入聋哑：记住当前麦状态，然后闭麦
      this.deafen = true
      this.micEnabledBeforeDeafen = this.micEnabled
      this.setMicState(false)
    }
    this.applyDeafenToAudio()
    this.set({ deafen: this.deafen })
  }

  /** 把聋哑状态应用到所有远端 audio 元素 */
  applyDeafenToAudio() {
    for (const pid in this.els.peer) {
      const a = this.els.peer[pid].audio
      if (a) a.muted = this.deafen
    }
  }
  toggleShare() {
    this.sharing ? this.stopShare() : this.startShare()
  }
  toggleAsr() {
    if (!this.room) {
      this.toast("请先加入房间")
      return
    }
    if (this.asrInfo && !this.asrInfo.enabled) {
      this.toast("服务器未启用语音转写")
      return
    }
    this.wsSend({ type: "asr-toggle", on: !this.asrActive })
  }
  setShareResolution(v: number) {
    this.set({ shareResolution: v })
    if (this.sharing) {
      this.toast("分辨率将在下次共享时生效")
      this.updateSenderParams()
    }
  }
  setShareFramerate(v: number) {
    this.set({ shareFramerate: v })
    if (this.sharing) this.updateSenderParams()
  }
  async setMicDevice(deviceId: string) {
    if (!deviceId) return
    const ok = await this.ensureMic(deviceId)
    this.toast(ok ? "麦克风已切换" : "切换麦克风失败")
  }
  setNoiseMode(mode: NoiseMode) {
    this.applyNoiseMode(mode)
      .then(() => {
        const names: Record<NoiseMode, string> = { none: "已关闭降噪", rnnoise: "已启用 RNNoise 降噪" }
        this.toast(names[mode] || "")
      })
      .catch((err) => this.toast("降噪切换失败：" + msgOf(err)))
  }
  async copyId(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.myId)
      return true
    } catch (e) {
      return false
    }
  }

  // ================= 元素注册（React 组件调用） =================
  registerSelfVideo(el: HTMLVideoElement | null) {
    this.els.selfVideo = el
    // 共享中时元素（重新）挂载：直接接上当前屏幕流（如共享网格切换时）
    if (el && this.screenStream) {
      el.srcObject = this.screenStream
      el.play().catch(() => {})
    }
  }
  /** 注册某人的媒体元素。音频（隐藏层）与视频（共享网格瓦片）可能由不同组件注册，这里做合并而非覆盖 */
  registerPeerEls(peerId: string, els: PeerEls) {
    this.els.peer[peerId] = Object.assign({}, this.els.peer[peerId], els)
    this.attachRemoteAudio(peerId)
    this.syncPeerVideo(peerId)
  }
  /** 注销部分元素：keys 为数组时只移除对应键（如 ["audio"]），否则整体移除 */
  unregisterPeerEls(peerId: string, keys?: ("audio" | "video")[]) {
    if (keys && Array.isArray(keys) && this.els.peer[peerId]) {
      for (const k of keys) delete this.els.peer[peerId][k]
    } else {
      delete this.els.peer[peerId]
    }
  }
  registerPinEl(peerId: string, video: HTMLVideoElement | null) {
    if (!video) return
    this.els.pin[peerId] = video
    this.syncPeerVideo(peerId)
  }
  unregisterPinEl(peerId: string) {
    delete this.els.pin[peerId]
  }

  // ================= 初始化 =================
  async getMachineId(): Promise<string> {
    if (await waitTauri()) {
      try {
        const id = await Promise.race([
          tauriInvoke("get_machine_id"),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), 3000),
          ),
        ])
        if (id) return formatId(String(id))
      } catch (e) {
        console.warn("Rust get_machine_id 失败，回退浏览器模式", e)
      }
    }
    let id = localStorage.getItem("sc_machine_id")
    if (!id) {
      const seed = [
        navigator.userAgent,
        screen.width + "x" + screen.height,
        navigator.hardwareConcurrency || 0,
        Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        uuid(),
      ].join("|")
      id = "WEB-" + hashHex(seed).slice(0, 12).toUpperCase()
      localStorage.setItem("sc_machine_id", id)
    }
    return id
  }

  async init() {
    if (this.initialized) return
    this.initialized = true
    try {
      this.myId = await this.getMachineId()
    } catch (e) {
      this.myId = "ERR-" + hashHex(uuid()).slice(0, 12).toUpperCase()
    }
    this.set({ myId: this.myId })

    // 自动播放策略解锁：任意点击/按键后重试被拦截的远端音频
    const resume = () => this.resumeRemoteAudio()
    ;["pointerdown", "keydown", "touchstart"].forEach((ev) => {
      document.addEventListener(ev, resume, { passive: true })
    })
    // 设备变更监听（插拔耳机等）
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        this.enumerateMicDevices()
      })
    }

    console.log(
      window.__TAURI__ ? "运行于 Tauri 桌面端" : "运行于浏览器（备用模式）",
    )
    this.set({ ready: true })
  }
}

export const engine = new Engine()
