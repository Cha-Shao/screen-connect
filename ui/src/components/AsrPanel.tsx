import { useEffect, useRef } from "react"
import { useEngine } from "../hooks"
import { engine, ENGINE_LABELS, fmtHm } from "../engine"

/**
 * 语音转写面板（嵌入式，替代原浮动弹窗）。
 * 只在整个房间开启 ASR 模式时显示；新加入的用户会通过 asr-history 拿到
 * 从转写开始到现在的全部内容。
 */
export default function AsrPanel() {
  const snap = useEngine()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [snap.asrLines.length])

  // 只有打开 ASR 模式才出现
  if (!snap.asrActive || !snap.room) return null

  const title =
    "语音转写日志 · " +
    (snap.roomName || snap.room) +
    (ENGINE_LABELS[snap.asrActiveMode] || "")

  return (
    <aside className="w-[280px] flex-[0_0_280px] flex flex-col bg-panel border-l border-line overflow-hidden">
      <div className="flex items-center gap-sm px-lg py-md border-b border-line shrink-0">
        <span className="text-sm">📝</span>
        <span className="text-xs font-semibold flex-1 truncate" title={title}>
          {title}
        </span>
        <button
          className="btn btn-xs btn-ghost shrink-0"
          title="下载 TXT（从开始到目前的全部内容）"
          onClick={() => engine.downloadAsrLog()}
        >
          ⬇ TXT
        </button>
      </div>
      <div
        ref={bodyRef}
        className="flex-1 overflow-y-auto px-md py-sm text-[12px] leading-relaxed min-h-[90px]"
      >
        {snap.asrLines.map((l, i) =>
          l.kind === "sys" ? (
            <div key={i} className="asr-sys">
              {l.text} {fmtHm(l.t)}
            </div>
          ) : (
            <div key={i} className="asr-line">
              <span className="asr-who">{(l.nickname || "?") + "："}</span>
              <span className="asr-text">{l.text}</span>
              <span className="asr-time">{fmtHm(l.t)}</span>
            </div>
          ),
        )}
        {snap.asrLines.length === 0 && (
          <div className="py-xl text-center text-tip text-xs">
            转写中，等待第一句话…
          </div>
        )}
      </div>
    </aside>
  )
}
