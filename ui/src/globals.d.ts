/// <reference types="vite/client" />

/** Tauri 桌面端桥（浏览器模式下不存在） */
interface Window {
  __TAURI__?: {
    core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
    invoke?: (cmd: string, args?: unknown) => Promise<unknown>
  }
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args?: unknown) => Promise<unknown>
  }
  webkitAudioContext?: typeof AudioContext
}
