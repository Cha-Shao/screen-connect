"use strict"
/**
 * screen-connect ASR 模块
 * - 语音活动检测（VAD）：对每个用户 16kHz/16bit 单声道 PCM 流做能量检测，切分语句
 * - whisper.cpp（本地 base 模型）转写：逐句调用 whisper-cli
 * - 会话管理：每个房间一次"开关"为一个 group，日志行按 房间-开始-结束.txt 落盘
 *
 * 音频协议（客户端 -> 服务器，WebSocket 二进制帧）：
 *   [4 字节大端 header 长度][JSON header][Int16LE PCM @16kHz 单声道]
 *   header: { type: 'asr-audio', room: '<roomId>' }
 *
 * 转写结果行（结构化）：
 *   { t: epochMs, kind: 'sys' | 'user', nickname?, text }
 *   kind='sys'   -> 系统行（开启/关闭）
 *   kind='user'  -> 用户转写行
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const http = require("http")
const https = require("https")
const { execFile } = require("child_process")

// ---------- 小工具 ----------
const PAD2 = (n) => String(n).padStart(2, "0")

/** HH:MM */
function fmtClock(ts) {
  const d = new Date(ts)
  return PAD2(d.getHours()) + ":" + PAD2(d.getMinutes())
}

/** YYYY-MM-DD_HH-MM-SS */
function fmtFile(ts) {
  const d = new Date(ts)
  return (
    d.getFullYear() +
    "-" +
    PAD2(d.getMonth() + 1) +
    "-" +
    PAD2(d.getDate()) +
    "_" +
    PAD2(d.getHours()) +
    "-" +
    PAD2(d.getMinutes()) +
    "-" +
    PAD2(d.getSeconds())
  )
}

/** 文件名安全化（保留中文） */
function sanitizeName(s) {
  return (
    String(s)
      .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "room"
  )
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr
        reject(err)
      } else resolve(stdout)
    })
  })
}

/** Int16Array -> 16kHz 单声道 16bit WAV（whisper-cli 输入格式） */
function buildWav(int16) {
  const n = int16.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // 单声道
  buf.writeUInt32LE(16000, 24) // 采样率
  buf.writeUInt32LE(32000, 28) // 字节率
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(int16[i], 44 + i * 2)
  return buf
}

// ---------- 语音活动检测 ----------
class VAD {
  /**
   * @param {object} opts vadThreshold/minSpeechMs/silenceFlushMs/maxUtteranceMs
   * @param {(samples: Int16Array) => void} onUtterance 语句结束回调
   */
  constructor(opts, onUtterance) {
    this.rate = 16000
    this.threshold = opts.vadThreshold != null ? opts.vadThreshold : 0.012
    this.minSpeechMs = opts.minSpeechMs != null ? opts.minSpeechMs : 600
    this.silenceFlushMs =
      opts.silenceFlushMs != null ? opts.silenceFlushMs : 900
    this.maxUtteranceMs =
      opts.maxUtteranceMs != null ? opts.maxUtteranceMs : 10000
    this.onUtterance = onUtterance
    this.chunks = []
    this.talking = false
    this.speechMs = 0
    this.silenceMs = 0
  }

  feed(int16) {
    // 能量（RMS）
    let sum = 0
    for (let i = 0; i < int16.length; i++) {
      const v = int16[i] / 32768
      sum += v * v
    }
    const rms = Math.sqrt(sum / int16.length)
    const ms = (int16.length / this.rate) * 1000

    if (rms >= this.threshold) {
      this.chunks.push(int16)
      this.speechMs += ms
      this.silenceMs = 0
      this.talking = true
    } else if (this.talking) {
      // 说话后的尾音静音段也暂存，直到静音阈值触发切句
      this.chunks.push(int16)
      this.silenceMs += ms
      if (this.silenceMs >= this.silenceFlushMs) this.flush()
    }
    // 超长语句强制切句
    if (this.talking && this.speechMs >= this.maxUtteranceMs) this.flush()
  }

  flush() {
    if (!this.talking) return
    const chunks = this.chunks
    this.chunks = []
    this.talking = false
    this.speechMs = 0
    this.silenceMs = 0
    let total = 0
    for (const c of chunks) total += c.length
    if (total < (this.rate * this.minSpeechMs) / 1000) return // 太短，忽略
    const out = new Int16Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    this.onUtterance(out)
  }
}

// ---------- whisper.cpp 封装 ----------
class Whisper {
  constructor(cfg) {
    this.cfg = cfg
    this.queue = Promise.resolve() // 串行化转写
    this.stats = { runs: 0, chars: 0, errors: 0 }
  }

  /** asr.whisper 配置段（bin/model/language/threads） */
  get w() {
    return this.cfg.whisper || {}
  }

  get ready() {
    if (this.cfg.mock) return true
    if (!this.w.bin || !this.w.model) return false
    return fs.existsSync(this.w.bin) && fs.existsSync(this.w.model)
  }

  /** 转写一句，返回文本；失败返回 null */
  transcribe(int16) {
    const run = async () => {
      if (this.cfg.mock) {
        await new Promise((r) => setTimeout(r, 200))
        return "（模拟转写：这是一段测试语音）"
      }
      const wavPath = path.join(
        os.tmpdir(),
        "sc-asr-" +
          Date.now() +
          "-" +
          Math.random().toString(36).slice(2, 8) +
          ".wav",
      )
      const outPrefix = wavPath.slice(0, -4)
      fs.writeFileSync(wavPath, buildWav(int16))
      const args = [
        "-m",
        this.w.model,
        "-f",
        wavPath,
        "-nt",
        "-otxt",
        "-of",
        outPrefix,
      ]
      if (this.w.language) args.push("-l", this.w.language)
      args.push("-t", String(this.w.threads || 4))
      // 动态链接的 whisper-cli 需要同目录下的 libwhisper.so.1 / libggml*.so：
      // 把二进制所在目录加进 LD_LIBRARY_PATH（Linux），避免"cannot open shared object file"
      const env = Object.assign({}, process.env)
      const binDir = path.dirname(this.w.bin)
      const lp = [binDir]
      if (process.env.LD_LIBRARY_PATH) lp.push(process.env.LD_LIBRARY_PATH)
      env.LD_LIBRARY_PATH = lp.join(path.delimiter)
      try {
        await execFileP(this.w.bin, args, {
          timeout: 60000,
          windowsHide: true,
          env,
        })
        let text = ""
        try {
          text = fs.readFileSync(outPrefix + ".txt", "utf8")
        } catch (e) {}
        text = text
          .replace(/\r/g, "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .join("")
        this.stats.runs++
        this.stats.chars += text.length
        return text || null
      } catch (e) {
        this.stats.errors++
        console.warn(
          "[asr] whisper 调用失败:",
          e.message,
          e.stderr ? "| " + String(e.stderr).slice(0, 200) : "",
        )
        return null
      } finally {
        try {
          fs.unlinkSync(wavPath)
        } catch (e) {}
        try {
          fs.unlinkSync(outPrefix + ".txt")
        } catch (e) {}
      }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }
}

// ---------- 阿里云百炼（qwen-audio-3.0-asr-flash，多模态 generation 接口）封装 ----------
/**
 * 引擎：qwen-audio-3.0-asr-flash（多模态语音识别，计费 ~0.00022 元/秒）
 * 接口：POST https://{workspaceId}.{region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 * 流程（每次 VAD 切好的一句话）：
 *   1) 把 16k 单声道 PCM 转成 WAV，base64 内联为 data:audio/wav;base64,xxx
 *   2) 放进 input.messages[0].content[0].input_audio.data 走多模态接口（支持 base64url，无需公网 URL），
 *      content 必须是 { type: "input_audio", input_audio: { data } } 结构（旧写法 { audio } 会 400）
 *   3) 默认同步调用（短音频直接返回文本）；若返回 output.task_id 则轮询任务。
 * 出错时打印完整响应体，便于排查。
 */
// 转写参数默认值 = 与实测可用的请求体一致（qwen-audio-3.0-asr-flash 只认 format/sample_rate，
// 传 language_hints 等无关参数会 400）。可通过 asr.aliyun.parameters 整体覆盖。
const DEFAULT_TRANSCRIBE_PARAMS = {
  format: "mp3",
  sample_rate: "16000",
}

/** 无语音内容（鼓掌/环境音等）：API 返回 400 + 空响应体 {}，视为"无内容"，静默忽略 */
class NoSpeechError extends Error {}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 极简 JSON HTTP 客户端（http/https），返回 { status, text, json }；网络错误/超时 reject */
function requestJson(url, opts) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      reject(new Error("非法 URL: " + url))
      return
    }
    const lib = u.protocol === "https:" ? https : http
    const payload =
      opts.body != null ? Buffer.from(JSON.stringify(opts.body)) : null
    const headers = Object.assign({}, opts.headers || {})
    if (payload) headers["Content-Length"] = payload.length
    const req = lib.request(
      u,
      { method: opts.method || "GET", headers },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json = null
          try {
            json = JSON.parse(text)
          } catch (e) {}
          resolve({ status: res.statusCode, text, json })
        })
      },
    )
    req.setTimeout(opts.timeout || 30000, () =>
      req.destroy(new Error("请求超时")),
    )
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 极简二进制 GET（自检下载示例音频用），返回 Buffer */
function requestBuffer(url, opts) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (e) {
      reject(e)
      return
    }
    const lib = u.protocol === "https:" ? https : http
    const req = lib.request(u, { method: "GET" }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve(Buffer.concat(chunks)))
    })
    req.setTimeout((opts && opts.timeout) || 30000, () =>
      req.destroy(new Error("请求超时")),
    )
    req.on("error", reject)
    req.end()
  })
}

/** 从多模态 generation 响应 output 里提取文本：output.choices[0].message.content[].text / 字符串 */
function extractMultimodalText(output) {
  if (!output) return ""
  const choices = output.choices
  if (Array.isArray(choices) && choices[0] && choices[0].message) {
    const c = choices[0].message.content
    if (typeof c === "string" && c.trim()) return c.trim()
    if (Array.isArray(c)) {
      const parts = []
      for (const p of c) {
        if (p && typeof p.text === "string" && p.text.trim())
          parts.push(p.text.trim())
      }
      if (parts.length) return parts.join("")
    }
  }
  // 兜底：兼容 output.text / output.results[].transcripts[].text
  return extractTranscriptionText(output)
}

/** 从转写响应 output 里提取文本：兼容 output.text 与 output.results[].transcripts[].text */
function extractTranscriptionText(output) {
  if (!output) return ""
  if (typeof output.text === "string" && output.text.trim())
    return output.text.trim()
  const parts = []
  if (Array.isArray(output.results)) {
    for (const r of output.results) {
      if (!r) continue
      if (typeof r.text === "string" && r.text.trim()) parts.push(r.text.trim())
      if (Array.isArray(r.transcripts)) {
        for (const t of r.transcripts) {
          if (t && typeof t.text === "string" && t.text.trim())
            parts.push(t.text.trim())
        }
      }
    }
  }
  return parts.join("")
}

/**
 * 归一化 16k Int16 PCM：峰值过低时整体放大到目标峰值（约 -1.4dBFS）。
 * 原因：客户端 rnnoise 降噪输出会被压到约 1/4 幅度，导致送去做 ASR 的音频过小
 * （人耳听着正常，但 ASR 模型对电平敏感，容易"识别不到语音"）。
 * 已有足够响度时保持不变；接近静音不放大。
 */
function normalizePcm(int16) {
  const TARGET = 0.85 // 目标峰值（相对满幅）
  let peak = 0
  for (let i = 0; i < int16.length; i++) {
    const a = Math.abs(int16[i])
    if (a > peak) peak = a
  }
  if (peak < 64) return int16 // 基本静音，不放大
  const maxPeak = Math.floor(32767 * TARGET)
  if (peak >= maxPeak) return int16 // 已足够响
  const gain = maxPeak / peak
  const out = new Int16Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(int16[i] * gain)))
  }
  return out
}

class AliyunBailianFiletrans {
  constructor(cfg) {
    this.cfg = cfg
    this.queue = Promise.resolve() // 与本地引擎一致的串行队列
    this.stats = { runs: 0, chars: 0, errors: 0 }
    const a = cfg.aliyun || {}
    this.apiKey = a.apiKey || process.env.DASHSCOPE_API_KEY || ""
    this.workspaceId = a.workspaceId || ""
    this.model = a.model || "qwen-audio-3.0-asr-flash"
    this.region = a.region || "cn-beijing"
    // 转写参数：默认与百炼文档示例一致；可用 asr.aliyun.parameters 整体覆盖/扩展
    this.parameters = Object.assign(
      {},
      DEFAULT_TRANSCRIBE_PARAMS,
      a.parameters || {},
    )
    this.timeoutMs = a.timeoutMs || 60000 // 转写请求超时
    this.pollIntervalMs = a.pollIntervalMs || 1500
    this.pollTimeoutMs = a.pollTimeoutMs || 120000
    // 自检：启动后用官方示例音频跑一遍转写，验证 Key/服务/地域是否可用
    this.selfTest = !!a.selfTest
    this.selfTestAudioUrl =
      a.selfTestAudioUrl ||
      "https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/hello_world_female2.wav"
    // 失败音频保留目录（转写失败时把这段 WAV 写到这里便于排查）
    this.audioDir = a.audioDir
      ? path.resolve(cfg.rootDir || __dirname, a.audioDir)
      : path.resolve(cfg.rootDir || __dirname, "asr-audio")
    // API 基地址（测试/代理可整体覆盖，如 http://127.0.0.1:8123）
    this.baseUrl =
      (a.baseUrl || "").replace(/\/+$/, "") ||
      "https://" + this.workspaceId + "." + this.region + ".maas.aliyuncs.com"
    try {
      this._sweepStale()
    } catch (e) {}
    if (this.selfTest) {
      setTimeout(() => this._selfTest().catch(() => {}), 1500)
    }
  }

  /** 自检：下载官方示例音频 -> base64 -> 走完整多模态转写流程（mock 模式跳过） */
  async _selfTest() {
    if (this.cfg.mock) return
    console.log("[asr] 自检：下载示例音频并转写", this.selfTestAudioUrl)
    try {
      const buf = await requestBuffer(this.selfTestAudioUrl, { timeout: 30000 })
      if (!buf || buf.length < 44) {
        console.warn("[asr] 自检失败：示例音频下载失败（长度异常）")
        return
      }
      const text = await this._transcribeMultimodal(
        "data:audio/wav;base64," + buf.toString("base64"),
      )
      if (text) {
        console.log("[asr] 自检通过，示例音频转写结果:", JSON.stringify(text))
      } else {
        console.warn(
          "[asr] 自检失败：示例音频也未转写出文字。说明是 API Key / 服务开通 / 地域 / 模型名的问题，而不是录音内容的问题。",
        )
      }
    } catch (e) {
      console.warn("[asr] 自检异常:", e.message)
    }
  }

  get ready() {
    if (this.cfg.mock) return true
    return !!(this.apiKey && this.workspaceId)
  }

  /** 启动时清理 1 小时前的临时音频目录（异常退出残留） */
  _sweepStale() {
    if (!fs.existsSync(this.audioDir)) return
    const cutoff = Date.now() - 3600 * 1000
    for (const name of fs.readdirSync(this.audioDir)) {
      try {
        const p = path.join(this.audioDir, name)
        if (fs.statSync(p).mtimeMs < cutoff)
          fs.rmSync(p, { recursive: true, force: true })
      } catch (e) {}
    }
  }

  /** 转写一句（VAD 已切好的 16k Int16 PCM），返回文本；失败返回 null */
  transcribe(int16) {
    const run = async () => {
      if (this.cfg.mock) {
        await new Promise((r) => setTimeout(r, 200))
        return "（模拟转写：这是一段测试语音）"
      }
      return await this._transcribeUtterance(int16)
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  /** 一句话：PCM -> 归一化 -> WAV -> base64 内联 -> 多模态转写；真错误保留音频供排查 */
  async _transcribeUtterance(int16) {
    let wav = null
    let keepForDebug = false // 仅"真错误"（非 400 空响应的无语音内容）保留音频
    try {
      wav = buildWav(normalizePcm(int16))
      const dataUrl = "data:audio/wav;base64," + wav.toString("base64")
      const text = await this._transcribeMultimodal(dataUrl)
      keepForDebug = !text // 无结果（非 NoSpeechError 路径）保留音频
      return text
    } catch (e) {
      if (e instanceof NoSpeechError) return null // 无语音内容：静默忽略，不计数/不告警/不保存
      this.stats.errors++
      console.warn("[asr] 阿里云转写失败:", e.message)
      keepForDebug = true
      return null
    } finally {
      if (keepForDebug && wav) {
        try {
          // 转写失败：把这段 WAV 写到 failed/ 保留，方便试听/手动提交验证
          const failedDir = path.join(this.audioDir, "failed")
          fs.mkdirSync(failedDir, { recursive: true })
          const keep = path.join(
            failedDir,
            fmtFile(Date.now()) + "-" + Date.now().toString(36) + ".wav",
          )
          fs.writeFileSync(keep, wav)
          console.warn("[asr] 转写失败的音频已保留: " + keep)
        } catch (e) {}
      }
    }
  }

  /** 调多模态 generation 接口：base64 音频同步调用（短音频直接返回文本）；返回 task_id 则轮询 */
  async _transcribeMultimodal(dataUrl) {
    // 请求体结构 = 实测可用样例（URL 与 base64 同构）：
    //   content[0] = { type: "input_audio", input_audio: { data: "<url 或 data:audio/wav;base64,...>" } }
    const body = {
      model: this.model,
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: dataUrl },
              },
            ],
          },
        ],
      },
      parameters: this.parameters,
    }
    const headers = {
      Authorization: "Bearer " + this.apiKey,
      "Content-Type": "application/json",
      // 禁用 SSE 流式返回：同步调用等单个 JSON 响应（不用 X-DashScope-Async）
      "X-DashScope-SSE": "disable",
    }
    const url =
      this.baseUrl + "/api/v1/services/aigc/multimodal-generation/generation"

    let resp
    try {
      resp = await requestJson(url, {
        method: "POST",
        headers,
        body,
        timeout: this.timeoutMs,
      })
    } catch (e) {
      this.stats.errors++
      console.warn(
        "[asr] 阿里云多模态转写请求失败（网络/超时）:",
        url,
        "|",
        e.message,
      )
      return null
    }
    if (!resp || resp.status !== 200 || !resp.json) {
      // 无语音内容（鼓掌/环境音等）：API 返回 HTTP 400 + 空响应体 {}，视为"无内容"，
      // 静默忽略（不计数/不告警/不保存音频）；其他 4xx/5xx 才按真错误处理
      if (resp && resp.status === 400 && /^\s*(\{\})?\s*$/.test(resp.text || "")) {
        throw new NoSpeechError("no speech content (HTTP 400 + 空响应体)")
      }
      this.stats.errors++
      console.warn(
        "[asr] 阿里云多模态转写失败: HTTP",
        resp && resp.status,
        "| 响应体:",
        resp ? resp.text || JSON.stringify(resp.json) || "(空)" : "(无响应)",
      )
      return null
    }
    const output = resp.json.output || {}
    // 服务端返回了任务 ID（异步）-> 轮询
    if (output.task_id) return await this._pollTask(output.task_id)
    // 同步直接出文本（output.choices[0].message.content[].text）
    const text = extractMultimodalText(output)
    if (text) {
      this.stats.runs++
      this.stats.chars += text.length
      return text
    }
    this.stats.errors++
    console.warn(
      "[asr] 阿里云多模态转写无结果: 响应体:",
      resp.text || JSON.stringify(resp.json),
    )
    return null
  }

  /** 轮询异步任务：GET /api/v1/tasks/{taskId}，SUCCEEDED 后取 /result；失败/超时打印详情 */
  async _pollTask(taskId) {
    const base = this.baseUrl + "/api/v1/tasks/" + encodeURIComponent(taskId)
    const headers = { Authorization: "Bearer " + this.apiKey }
    const deadline = Date.now() + this.pollTimeoutMs
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs)
      let resp
      try {
        resp = await requestJson(base, { headers, timeout: 15000 })
      } catch (e) {
        console.warn(
          "[asr] 轮询任务请求失败（网络/超时）: task_id=" + taskId,
          "|",
          e.message,
        )
        continue
      }
      if (!resp || !resp.json || !resp.json.output) {
        console.warn(
          "[asr] 轮询任务返回异常: HTTP",
          resp && resp.status,
          "| 响应体:",
          resp ? resp.text || JSON.stringify(resp.json) || "(空)" : "(无响应)",
        )
        continue
      }
      const out = resp.json.output
      const st = out.task_status
      if (st === "SUCCEEDED") {
        // 取最终结果（/result），失败则退而用任务查询响应里的 results
        let t = ""
        try {
          const rr = await requestJson(base + "/result", {
            headers,
            timeout: 15000,
          })
          if (rr && rr.json) t = extractTranscriptionText(rr.json.output || {})
          else
            console.warn(
              "[asr] 取任务结果失败: HTTP",
              rr && rr.status,
              "| 响应体:",
              rr ? rr.text : "(无响应)",
            )
        } catch (e) {
          console.warn("[asr] 取任务结果请求失败:", e.message)
        }
        if (!t) t = extractTranscriptionText(out)
        if (t) {
          this.stats.runs++
          this.stats.chars += t.length
          return t
        }
        this.stats.errors++
        console.warn(
          "[asr] 任务成功但无转写文本: task_id=" + taskId,
          "| 响应体:",
          JSON.stringify(out).slice(0, 500),
        )
        return null
      }
      if (st === "FAILED" || st === "CANCELED") {
        this.stats.errors++
        console.warn(
          "[asr] 阿里云异步任务失败: task_id=" + taskId,
          "| status:",
          st,
          "| 详情:",
          JSON.stringify(out).slice(0, 500),
        )
        return null
      }
      // PENDING / RUNNING：继续轮询
    }
    this.stats.errors++
    console.warn(
      "[asr] 阿里云异步任务超时: task_id=" + taskId,
      "（超过",
      this.pollTimeoutMs,
      "ms）",
    )
    return null
  }
}

/**
 * 去掉中日韩字符之间的分词空格："你 知道 我 要 说 什么" -> "你知道我要说什么"；
 * 英文单词之间的空格保留（"hello world 测试" -> "hello world 测试"）。
 * 可用于 vosk / whisper 等按词输出空格的引擎。
 */
function stripCjkSpaces(text) {
  const CJK =
    "\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef"
  return String(text || "").replace(
    new RegExp("([" + CJK + "])\\s+(?=[" + CJK + "])", "g"),
    "$1",
  )
}

// ---------- Vosk（本地离线识别）封装 ----------
/**
 * vosk 为可选依赖（npm install vosk --no-save），模型需单独下载解压：
 *   小模型（中文，约 42MB）: https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
 *   大模型（中文，约 1.4GB）: https://alphacephei.com/vosk/models/vosk-model-cn-0.22.zip
 * 配置：asr.vosk.modelDir 指向解压后的模型目录。
 */
class VoskTranscriber {
  constructor(cfg) {
    this.cfg = cfg
    this.queue = Promise.resolve()
    this.stats = { runs: 0, chars: 0, errors: 0 }
    this._vosk = null
    this._model = null
  }

  get modelDir() {
    const d = this.cfg.vosk && this.cfg.vosk.modelDir
    return d ? path.resolve(this.cfg.rootDir, d) : ""
  }

  /**
   * 就绪检查（轻量、不加载模型）：只确认 vosk 模块可加载 + 模型目录存在。
   * 模型数据推迟到真正用 vosk 转写时才加载，避免默认引擎不是 vosk 时白白占用内存/启动时间。
   */
  get ready() {
    if (this.cfg.mock) return true
    if (!this.modelDir || !fs.existsSync(this.modelDir)) return false
    try {
      this._loadModule()
      return true
    } catch (e) {
      return false
    }
  }

  /** 加载 vosk 原生模块（体积小；可选依赖，未安装时抛错 -> ready=false） */
  _loadModule() {
    if (this._vosk) return
    this._vosk = require("vosk")
    if (typeof this._vosk.setLogLevel === "function") this._vosk.setLogLevel(0)
  }

  /** 真正加载模型（较慢，首次转写时按需触发） */
  _ensure() {
    this._loadModule()
    if (!this._model) this._model = new this._vosk.Model(this.modelDir)
  }

  /** 会话开启时后台预热：提前把模型加载好，避免首次转写卡顿（mock 模式不加载） */
  async warmup() {
    if (this.cfg.mock) return
    try {
      this._ensure()
    } catch (e) {
      console.warn("[asr] vosk 模型预热失败:", e.message)
    }
  }

  /** 转写一句（VAD 已切好的一段 PCM），返回文本；失败返回 null */
  transcribe(int16) {
    const run = async () => {
      if (this.cfg.mock) {
        await new Promise((r) => setTimeout(r, 150))
        return "（模拟转写：这是一段测试语音）"
      }
      try {
        this._ensure()
        const rec = new this._vosk.Recognizer({
          model: this._model,
          sampleRate: 16000,
        })
        let text = ""
        try {
          const buf = Buffer.from(
            int16.buffer,
            int16.byteOffset,
            int16.byteLength,
          )
          rec.acceptWaveform(buf)
          // 尾部补一小段静音，让 vosk 落定最终结果（0.2s @16k）
          rec.acceptWaveform(Buffer.alloc(3200))
          const res = rec.result()
          text = String((res && res.text) || "").trim()
          // vosk 默认按词加空格；中文场景去掉中文分词空格（可配置 asr.vosk.noSpaces: false 关闭该处理）
          if (!(this.cfg.vosk && this.cfg.vosk.noSpaces === false)) {
            text = stripCjkSpaces(text)
          }
        } finally {
          try {
            rec.free()
          } catch (e) {}
        }
        this.stats.runs++
        this.stats.chars += text.length
        return text || null
      } catch (e) {
        this.stats.errors++
        console.warn("[asr] vosk 转写失败:", e.message)
        return null
      }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }
}

// ---------- Silero VAD 人声门控（送 ASR 前先判有没有人声，挡掉鼓掌/环境音） ----------
/**
 * 用 onnxruntime-node 跑 silero_vad.onnx（~2MB，16kHz 单声道）逐帧输出语音概率，
 * 对整句统计"判定为语音"的时长：低于 minSpeechMs 或占比过低 -> 判为无人声，直接丢弃
 * （不发阿里云，省钱也避免"无内容 400 {}"）。onnxruntime-node / 模型缺失时自动降级放行。
 *
 * 依赖（可选）：
 *   bash setup-silero-vad.sh   # 下载 silero/silero_vad.onnx + npm install onnxruntime-node --no-save
 */
class SileroVadGate {
  constructor(cfg) {
    this.cfg = cfg || {}
    const g = this.cfg.speechGate || {}
    this.enabled = !!(g.enabled !== false && g.mode === "silero" && g.model)
    this.modelPath = g.model
      ? path.isAbsolute(g.model)
        ? g.model
        : path.resolve(this.cfg.rootDir || __dirname, g.model)
      : ""
    this.threshold = g.threshold != null ? g.threshold : 0.5 // 单帧语音概率阈值
    this.minSpeechMs = g.minSpeechMs != null ? g.minSpeechMs : 300 // 最少语音时长
    this.minSpeechRatio = g.minSpeechRatio != null ? g.minSpeechRatio : 0.15 // 语音时长占比下限
    this._session = null
    this._warned = false
    this.stats = { runs: 0, speech: 0, notSpeech: 0, errors: 0 }
  }

  get ready() {
    if (!this.enabled) return false
    if (this._session) return true
    try {
      require.resolve("onnxruntime-node")
    } catch (e) {
      return false
    }
    return fs.existsSync(this.modelPath)
  }

  _warnOnce(msg) {
    if (this._warned) return
    this._warned = true
    console.warn("[asr] Silero 人声门控不可用（已放行全部音频）:", msg)
  }

  async _ensure() {
    if (this._session) return
    const ort = require("onnxruntime-node")
    this._session = await ort.InferenceSession.create(this.modelPath)
  }

  /** 判断一句 16k Int16 PCM 是否含人声；门控故障时放行（返回 true，不挡正常转写） */
  async isSpeech(int16) {
    if (!this.enabled) return true
    if (!this.ready) {
      this._warnOnce(
        "缺少 onnxruntime-node 或模型文件 " + this.modelPath + "（跑 bash setup-silero-vad.sh）",
      )
      return true
    }
    try {
      await this._ensure()
      const ort = require("onnxruntime-node")
      const f32 = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
      const CH = 512 // silero 输入帧：32ms @16k
      const nChunks = Math.ceil(f32.length / CH)
      let h = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64])
      let c = new ort.Tensor("float32", new Float32Array(2 * 64), [2, 1, 64])
      const sr = new ort.Tensor("int64", new BigInt64Array([16000n]), [1])
      let speechMs = 0
      for (let i = 0; i < nChunks; i++) {
        const off = i * CH
        const rem = f32.length - off
        let chunk
        if (rem >= CH) {
          chunk = f32.subarray(off, off + CH)
        } else {
          chunk = new Float32Array(CH) // 末帧补零
          chunk.set(f32.subarray(off))
        }
        const res = await this._session.run({
          input: new ort.Tensor("float32", chunk, [1, CH]),
          sr,
          h,
          c,
        })
        if (res.hn && res.cn) {
          h = res.hn
          c = res.cn
        } else {
          const st = stateFrom(res)
          h = st[0] || h
          c = st[1] || c
        }
        if (probOf(res) >= this.threshold) speechMs += 32
      }
      const totalMs = nChunks * 32
      this.stats.runs++
      const speech =
        speechMs >= this.minSpeechMs && speechMs / totalMs >= this.minSpeechRatio
      if (speech) this.stats.speech++
      else this.stats.notSpeech++
      return speech
    } catch (e) {
      this.stats.errors++
      this._warnOnce(e.message)
      return true
    }
  }
}

/** 从 onnx 输出里取语音概率（兼容不同输出命名：output / 形状 [1,1] 的那个张量） */
function probOf(res) {
  if (res.output) return res.output.data[0]
  const v = Object.values(res).find(
    (t) => t && t.dims && t.dims.length === 2 && t.dims[0] === 1 && t.dims[1] === 1,
  )
  return v ? v.data[0] : 0
}

/** 从 onnx 输出里取状态张量 h/c（兼容 hn/cn 命名） */
function stateFrom(res) {
  const vals = Object.values(res).filter(
    (t) => t && t.dims && t.dims.length === 3 && t.dims[0] === 2 && t.dims[2] === 64,
  )
  return [vals[0], vals[1]]
}

/** 按 cfg.asr.speechGate 创建门控；未启用返回 null */
function createSpeechGate(cfg) {
  const g = new SileroVadGate(cfg)
  return g.enabled ? g : null
}

// ---------- 转写引擎工厂 ----------
/** @returns {{ready: boolean, transcribe: (Int16Array)=>Promise<string|null>, stats: object}} */
function createTranscriber(mode, cfg) {
  if (mode === "aliyun-bailian") return new AliyunBailianFiletrans(cfg)
  if (mode === "local-vosk") return new VoskTranscriber(cfg)
  return new Whisper(cfg) // local-whisper
}

// ---------- ASR 管理器 ----------
/**
 * @param {object} cfg 合并默认值后的配置（whisper.bin/model 需已解析为绝对路径）
 * @param {{ onLine?: (roomId, line) => void }} hooks
 */
function createAsrManager(cfg, hooks) {
  const MODES = ["local-vosk", "local-whisper", "aliyun-bailian"]
  const transcoders = {
    "local-vosk": createTranscriber("local-vosk", cfg),
    "local-whisper": createTranscriber("local-whisper", cfg),
    "aliyun-bailian": createTranscriber("aliyun-bailian", cfg),
  }
  const sessions = new Map() // roomId -> session
  const logDir = path.isAbsolute(cfg.logDir)
    ? cfg.logDir
    : path.resolve(cfg.rootDir, cfg.logDir)
  const defaultMode = MODES.indexOf(cfg.mode) >= 0 ? cfg.mode : "local-whisper"
  // 人声门控：送 ASR 前先判有没有人声（Silero VAD），鼓掌/环境音直接丢弃
  const speechGate = createSpeechGate(cfg)

  function lineText(l) {
    return l.kind === "sys"
      ? l.text + " " + fmtClock(l.t)
      : (l.nickname || "?") + "：" + l.text + " " + fmtClock(l.t)
  }

  function appendToFile(sess, line) {
    try {
      fs.appendFileSync(sess.filePath, lineText(line) + "\n")
    } catch (e) {
      console.warn("[asr] 写日志文件失败:", e.message)
    }
  }

  /** 开启一个会话（group），返回 session；若该房间已有会话返回 null */
  function start(roomId, roomName, mode) {
    if (sessions.has(roomId)) return null
    const m = MODES.indexOf(mode) >= 0 ? mode : defaultMode
    const transcoder = transcoders[m]
    if (!transcoder || !transcoder.ready) return null // 引擎未配置/不可用
    if (typeof transcoder.warmup === "function") transcoder.warmup() // 按需预热（如 vosk 后台加载模型，不阻塞开转写）
    const startTs = Date.now()
    const fileName =
      sanitizeName(roomName || roomId) + "-" + fmtFile(startTs) + ".txt"
    const filePath = path.join(logDir, fileName)
    try {
      fs.mkdirSync(logDir, { recursive: true })
    } catch (e) {}
    const sess = {
      roomId,
      roomName: roomName || roomId,
      mode: m,
      transcoder,
      startTs,
      endTs: null,
      lines: [],
      buffers: new Map(), // userId -> VAD
      filePath,
      fileName,
      working: true,
    }
    const openLine = { t: startTs, kind: "sys", text: "语音转写开启" }
    sess.lines.push(openLine)
    appendToFile(sess, openLine)
    sessions.set(roomId, sess)
    console.log(
      `[asr] 转写开启 room=${roomId} ${fmtClock(startTs)} (引擎=${m}) -> ${fileName}`,
    )
    return sess
  }

  /** 关闭会话，落盘并重命名为 房间-开始-结束.txt */
  function stop(roomId) {
    const sess = sessions.get(roomId)
    if (!sess) return null
    const endTs = Date.now()
    const closeLine = { t: endTs, kind: "sys", text: "语音转写关闭" }
    sess.lines.push(closeLine)
    sess.endTs = endTs
    appendToFile(sess, closeLine)
    const finalName =
      sanitizeName(sess.roomName || sess.roomId) +
      "-" +
      fmtFile(sess.startTs) +
      "-" +
      fmtFile(endTs) +
      ".txt"
    const finalPath = path.join(logDir, finalName)
    try {
      fs.renameSync(sess.filePath, finalPath)
      sess.filePath = finalPath
      sess.fileName = finalName
    } catch (e) {
      console.warn("[asr] 重命名日志文件失败:", e.message)
    }
    sess.working = false
    sessions.delete(roomId)
    console.log(
      `[asr] 转写关闭 room=${roomId} ${fmtClock(endTs)} -> ${finalName} (${sess.lines.length} 行)`,
    )
    return sess
  }

  function active(roomId) {
    return sessions.get(roomId) || null
  }

  /** 喂入一段 PCM（Int16Array @16k），内部做 VAD，切句后人声门控 + 异步转写 */
  function feed(roomId, userId, nickname, int16) {
    const sess = sessions.get(roomId)
    if (!sess) return
    let vad = sess.buffers.get(userId)
    if (!vad) {
      vad = new VAD(cfg, (samples) => {
        const onText = (text) => {
          if (!text) return
          const line = {
            t: Date.now(),
            kind: "user",
            nickname: nickname || String(userId).slice(0, 8),
            text,
          }
          sess.lines.push(line)
          appendToFile(sess, line)
          if (hooks && hooks.onLine) hooks.onLine(sess.roomId, line)
        }
        const run = () =>
          sess.transcoder
            .transcribe(samples)
            .then(onText)
            .catch((e) => console.warn("[asr] 转写回调异常:", e.message))
        if (speechGate) {
          // 先判有没有人声：无人声（鼓掌/环境音等）静默丢弃，不送 ASR、不产行
          speechGate.isSpeech(samples).then((speech) => {
            if (speech) run()
          })
        } else {
          run()
        }
      })
      sess.buffers.set(userId, vad)
    }
    vad.feed(int16)
  }

  return {
    start,
    stop,
    active,
    feed,
    ready: (mode) => (transcoders[mode] || transcoders[defaultMode]).ready,
    stats: () => transcoders[defaultMode].stats,
    /** Silero 人声门控统计（未启用为 null）：runs/speech/notSpeech/errors */
    speechGateStats: () => (speechGate ? speechGate.stats : null),
    defaultMode,
    logDir,
    /** 引擎实际请求地址（诊断用；本地引擎为空） */
    engineBaseUrl: (mode) => (transcoders[mode] || {}).baseUrl || "",
    /** 阿里云引擎的失败音频保留目录（server.js 用它暴露 /asr-audio/failed/ 下载） */
    audioDir:
      (transcoders["aliyun-bailian"] &&
        transcoders["aliyun-bailian"].audioDir) ||
      "",
  }
}

module.exports = {
  createAsrManager,
  AliyunBailianFiletrans, // 导出供单元测试/诊断使用
  SileroVadGate, // 导出供单元测试/诊断使用
  fmtClock,
  fmtFile,
  sanitizeName,
  stripCjkSpaces,
}
