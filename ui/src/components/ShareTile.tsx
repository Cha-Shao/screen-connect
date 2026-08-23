import { useEffect, useRef } from "react"
import { engine } from "../engine"

interface ShareTileProps {
  id: string
  name: string
  isSelf: boolean
  playing: boolean
  pinned: boolean
}

/**
 * 共享网格瓦片：显示一个正在共享的成员。
 * - 别人的画面默认不显示内容，点击 ▶ 播放后才显示（peer.playing）
 * - 支持窗口放大（固定到中央大屏）与屏幕全屏
 */
export default function ShareTile({ id, name, isSelf, playing, pinned }: ShareTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (isSelf) {
      engine.registerSelfVideo(videoRef.current)
    } else {
      engine.registerPeerEls(id, { video: videoRef.current ?? undefined })
    }
    return () => {
      if (isSelf) engine.registerSelfVideo(null)
      else engine.unregisterPeerEls(id, ["video"])
    }
  }, [id, isSelf])

  return (
    <div className="relative bg-black rounded-xl overflow-hidden border border-line aspect-video [transform:translateZ(0)]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`w-full h-full object-contain bg-black${isSelf || playing ? "" : " hidden"}`}
      ></video>

      {!isSelf && !playing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-md bg-panel/40">
          <span className="text-tip text-xs">画面未加载</span>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => engine.togglePlay(id)}
          >
            ▶ 播放
          </button>
        </div>
      )}

      <div className="absolute left-sm top-sm flex items-center gap-xs px-sm py-xs sc-glass rounded-lg text-xs">
        <span className={playing ? "talking" : ""}>{name}</span>
        <span className="px-sm py-ty rounded-[5px] text-[9px] font-bold bg-warn/25 text-tip border border-warn/40">
          共享
        </span>
        {isSelf && (
          <span className="px-sm py-ty rounded-[5px] text-[9px] font-bold bg-success/25 text-tip border border-success/40">
            我
          </span>
        )}
      </div>

      <div className="absolute right-sm bottom-sm flex gap-xs">
        {!isSelf && (
          <>
            <button
              className="text-[11px] px-sm py-xs sc-glass rounded-lg cursor-pointer hover:bg-black/80"
              title={playing ? "暂停画面" : "播放画面"}
              onClick={() => engine.togglePlay(id)}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <button
              className={`text-[11px] px-sm py-xs sc-glass rounded-lg cursor-pointer hover:bg-black/80${pinned ? " bg-accent/40" : ""}`}
              title={pinned ? "取消窗口放大" : "窗口放大（铺满中间大屏）"}
              onClick={() => engine.togglePin(id)}
            >
              ⤢
            </button>
          </>
        )}
        <button
          className="text-[11px] px-sm py-xs sc-glass rounded-lg cursor-pointer hover:bg-black/80"
          title="屏幕全屏 / 退出全屏"
          onClick={() => engine.togglePeerFullscreen(id)}
        >
          ⛶
        </button>
      </div>
    </div>
  )
}
