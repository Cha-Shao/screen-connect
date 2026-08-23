// rnnoise 降噪 AudioWorkletProcessor
// 用法：每次 process 先把输入写到 exports.getInput(state) 返回的位置（该位置每次调用都会前进并回绕），
//       再调用 exports.pipe(state, n)，返回值就是本次输出块在 memory 中的位置。
// 注意：wasm 内存只有 320KB，newState 只能成功分配一个状态；不 deleteState 就再 newState 会返回 0（NULL），
//       拿 NULL 状态去 pipe 会立即 memory out of bounds 崩溃。主线程在关闭降噪/切换模式时，
//       必须向本节点端口 postMessage(false) 让本处理器 deleteState 释放状态。
// 本 worklet 做兜底：
//   1) 构造时 newState 返回 0（上一个状态未释放、内存耗尽）-> 标记 crashed 并立即上报主线程自动降级，
//      本块及后续直通原始输入（保证不静音、不写坏内存）；
//   2) pipe 异常（越界）-> 捕获后本块及后续直通原始输入（保证不静音），并通知主线程自动降级；
//   3) pipe 未产出（内部按 480 样本帧缓冲，可能返回 0）-> 本块直通原始输入，避免静音缺口。
let exports, mem
class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super({ ...options, numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    if (!exports) {
      exports = new WebAssembly.Instance(options.processorOptions.module).exports
      mem = new Float32Array(exports.memory.buffer)
    }
    this.state = exports.newState()
    this.alive = true
    this.crashed = false
    if (!this.state) {
      // 状态分配失败：直接上报异常，主线程会自动退回原始麦克风；这里标记 crashed，
      // process 里全程直通，绝不用 NULL 状态去写内存（会写坏 wasm 内存导致各种诡异问题）
      this.crashed = true
      try {
        this.port.postMessage({ crash: true })
      } catch (e) {}
    }
    this.statSize = Math.ceil(sampleRate / 128)
    this.stat = new Float32Array(2 * this.statSize)
    this.statPtr = 0
    this.ts = 0
    this.port.onmessage = ({ data }) => {
      if (!this.alive) return
      if (data && this.state) {
        const msg = { vadProb: exports.getVadProb(this.state) }
        if (data === "stat") msg.stat = this.stat
        this.port.postMessage(msg)
      } else if (!data) {
        this.alive = false
        // state 可能为 NULL（构造时分配失败）：deleteState(NULL) 会越界崩溃，必须跳过
        if (this.state) exports.deleteState(this.state)
      }
    }
  }
  process(inputs, outputs) {
    if (!this.alive) return false
    const input = inputs[0][0]
    const output = outputs[0][0]
    if (!input || !output) return true
    if (!this.crashed && this.state) {
      try {
        const inOff = exports.getInput(this.state) / 4
        mem.set(input, inOff)
        const h = exports.pipe(this.state, output.length) / 4
        if (h > 0 && h + output.length <= mem.length) {
          output.set(mem.subarray(h, h + output.length))
          this._stat()
          return true
        }
      } catch (err) {
        // wasm 越界崩溃：直通原始输入并通知主线程自动退回原始麦克风
        this.crashed = true
        try {
          this.port.postMessage({ crash: true })
        } catch (e) {}
      }
    }
    // pipe 未产出或已崩溃：本块直通原始输入，保证不静音
    output.set(input)
    this._stat()
    return true
  }
  _stat() {
    const now = Date.now()
    if (this.ts !== 0) {
      this.stat[this.statPtr] = now - this.ts
      this.stat[this.statPtr + this.statSize] = now - this.ts
      this.statPtr = (this.statPtr + 1) % this.statSize
    }
    this.ts = now
  }
}
registerProcessor("rnnoise", RNNoiseProcessor)
