import { useEffect, useRef, useState } from "react"
import { useEngine } from "../hooks"
import { engine, type NoiseMode } from "../engine"
import clsx from "clsx"

interface MicMenuState {
  x: number
  y: number
}

/**
 * 麦克风右键菜单：输入设备选择 + 降噪。
 * 不用 daisyUI dropdown（其 checkbox/focus 机制与本项目已有的自定义菜单模式冲突），
 * 沿用 Sidebar 里 MemberMenu 的 fixed 定位 + 点击外部关闭方案。
 */
function MicMenu({
  menu,
  onClose,
}: {
  menu: MicMenuState
  onClose: () => void
}) {
  const snap = useEngine()

  // 点击别处 / 滚动 / 失焦关闭
  useEffect(() => {
    const close = () => onClose()
    document.addEventListener("click", close)
    document.addEventListener("scroll", close, true)
    window.addEventListener("blur", close)
    return () => {
      document.removeEventListener("click", close)
      document.removeEventListener("scroll", close, true)
      window.removeEventListener("blur", close)
    }
  }, [onClose])

  const x = Math.max(8, Math.min(menu.x, window.innerWidth - 260))
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - 310))
  const activeMic =
    snap.micDeviceId || (snap.micDevices[0] ? snap.micDevices[0].deviceId : "")

  return (
    <div
      className="fixed z-[9000] w-[250px] sc-glass rounded-lg shadow-2xl p-sm flex flex-col gap-xs"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="px-md pt-xs pb-ty text-[12px] font-semibold text-tip">
        麦克风设置
      </div>

      <div className="px-md pt-xs text-[11px] text-tip">输入设备</div>
      {snap.micDevices.length === 0 && (
        <div className="px-md py-sm text-[11px] text-tip">
          未检测到麦克风设备
        </div>
      )}
      <div className="flex flex-col gap-ty px-xs max-h-[132px] overflow-y-auto">
        {snap.micDevices.map((m) => (
          <button
            key={m.deviceId}
            title={m.label}
            className={`flex items-center gap-sm px-md py-sm rounded-md text-[12px] cursor-pointer whitespace-nowrap transition-colors hover:bg-accent/15${m.deviceId === activeMic ? " bg-accent/20 text-tip" : ""}`}
            onClick={() => engine.setMicDevice(m.deviceId)}
          >
            <span className="text-xs">🎙️</span>
            <span className="flex-1 min-w-0 truncate text-left">{m.label}</span>
            {m.deviceId === activeMic && (
              <span className="text-success text-[11px]">✓</span>
            )}
          </button>
        ))}
      </div>

      <div className="border-t border-line my-xs" />

      <div className="px-md pt-xs text-[11px] text-tip">降噪</div>
      <div className="flex flex-col gap-ty px-xs pb-xs">
        {[
          { mode: "none", icon: "🚫", label: "无降噪" },
          { mode: "rnnoise", icon: "🌊", label: "RNNoise（推荐）" },
        ].map((o) => (
          <button
            key={o.mode}
            className={`flex items-center gap-sm px-md py-sm rounded-md text-[12px] cursor-pointer whitespace-nowrap transition-colors hover:bg-accent/15${snap.noiseMode === o.mode ? " bg-accent/20 text-tip" : ""}`}
            onClick={() => engine.setNoiseMode(o.mode as NoiseMode)}
          >
            <span className="text-xs">{o.icon}</span>
            <span className="flex-1 text-left">{o.label}</span>
            {snap.noiseMode === o.mode && (
              <span className="text-success text-[11px]">✓</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 控制栏卡片（三行：房间 / 屏幕共享 / 声音），毛玻璃浮在房间列表下方 */
export default function Controls() {
  const snap = useEngine()
  const [micMenu, setMicMenu] = useState<MicMenuState | null>(null)
  const startTime = useRef<number | null>(null)
  const [talkTime, setTalkTime] = useState<number | null>(null)

  const inRoom = !!snap.room

  useEffect(() => {
    let timer: NodeJS.Timeout
    if (inRoom) {
      startTime.current = Date.now()
      setTalkTime(0)
      timer = setInterval(() => {
        if (startTime.current) {
          setTalkTime(Date.now() - startTime.current)
        }
      }, 1e3)
    } else {
      startTime.current = null
      setTalkTime(null)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [inRoom])

  return (
    <>
      <section className="rounded-xl sc-glass shadow-xl p-md flex flex-col gap-sm">
        {/* 第一行：房间 */}
        <div className="flex items-center gap-sm">
          <span
            className={clsx(
              "w-sm h-sm rounded-full shrink-0",
              inRoom ? "bg-success animate-sc-pulse":"bg-muted"
            )}
            title={inRoom ? "已连接" : "未连接"}
          ></span>
          <span
            className={`flex-1 min-w-0 truncate text-[13px] font-semibold${inRoom ? "" : " text-tip"}`}
          >
            {inRoom ? snap.roomName : "未加入房间"}
          </span>
          {talkTime !== null && (
            <span className="text-[11px] text-tip shrink-0">
              {new Date(talkTime).toISOString().substr(11, 8)}
            </span>
          )}
          <button
            className={`btn btn-sm shrink-0${inRoom ? " btn-error" : " btn-ghost"}`}
            title={inRoom ? "退出房间" : "未加入房间"}
            disabled={!inRoom}
            onClick={() => engine.leaveToLobby()}
          >
            {/* 挂断图标：电话听筒朝下（SVG） */}
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.7l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </button>
        </div>

        {/* 第二行：屏幕共享 + 画质（一个 join） */}
        <div className="join w-full">
          <button
            className={`join-item btn btn-sm flex items-center gap-sm text-[13px] flex-1 ${snap.sharing ? "btn-warning" : ""}`}
            title={inRoom ? "共享屏幕" : "请先加入房间"}
            disabled={!inRoom}
            onClick={() => engine.toggleShare()}
          >
            <span>{snap.sharing ? "停止" : "共享"}</span>
          </button>
          <select
            className="join-item select select-bordered select-sm flex-1 min-w-0"
            title="共享分辨率"
            value={snap.shareResolution}
            onChange={(e) =>
              engine.setShareResolution(parseInt(e.target.value, 10))
            }
          >
            <option value="720">720p</option>
            <option value="1080">1080p</option>
          </select>
          <select
            className="join-item select select-bordered select-sm flex-1 min-w-0"
            title="共享帧率"
            value={snap.shareFramerate}
            onChange={(e) =>
              engine.setShareFramerate(parseInt(e.target.value, 10))
            }
          >
            <option value="30">30fps</option>
            <option value="60">60fps</option>
          </select>
        </div>

        {/* 第三行：声音控制（麦克风 + 耳机静音） */}
        <div className="flex items-center gap-sm">
          <button
            className={`flex-1 btn btn-sm ${snap.micEnabled ? "btn-success" : "btn-error"}`}
            title="左键：开关麦克风 · 右键：选择设备与降噪"
            onClick={() => engine.toggleMic()}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMicMenu({ x: e.clientX, y: e.clientY })
            }}
          >
            <span className="text-base">🎙️</span>
            {snap.noiseMode !== "none" && (
              <span
                className="ml-auto text-[10px] px-sm py-ty rounded-full bg-accent/20 text-tip border border-accent/40"
                title="RNNoise 降噪已开启（右键可关闭）"
              >
                🌊
              </span>
            )}
          </button>
          <button
            className={`flex-1 btn btn-sm ${snap.deafen ? "btn-error" : "btn-ghost"}`}
            title={
              snap.deafen
                ? "已静音：自己闭麦且听不到别人"
                : "静音：自己闭麦并听不到别人"
            }
            onClick={() => engine.toggleDeafen()}
          >
            <span className="text-base">🎧</span>
            {snap.deafen && (
              <span className="ml-auto text-[10px] px-sm py-ty rounded-full bg-error/25 text-tip border border-error/50">
                静音
              </span>
            )}
          </button>
        </div>
      </section>

      {micMenu && (
        <MicMenu
          key={`${micMenu.x}-${micMenu.y}`}
          menu={micMenu}
          onClose={() => setMicMenu(null)}
        />
      )}
    </>
  )
}
