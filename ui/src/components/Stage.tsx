import { useEffect, useRef } from "react"
import { useEngine } from "../hooks"
import { engine } from "../engine"
import PinTile from "./PinTile"
import ShareTile from "./ShareTile"

/** 共享成员网格列数：尽量让瓦片足够大 —— 1 人 1 列，2~6 人 2 列，7 人及以上才 3 列 */
function gridCols(n: number): number {
  if (n <= 1) return 1
  if (n <= 6) return 2
  return 3
}

interface SharingItem {
  id: string
  name: string
  self: boolean
}

export default function Stage() {
  const snap = useEngine()
  const selfVideoRef = useRef<HTMLVideoElement>(null)
  const inRoom = !!snap.room

  useEffect(() => {
    engine.registerSelfVideo(selfVideoRef.current)
  }, [])

  // 正在共享的人：自己（若在共享）+ 各对端
  const sharing: SharingItem[] = []
  if (snap.sharing) sharing.push({ id: snap.myId, name: snap.myNick, self: true })
  for (const [id, p] of Object.entries(snap.peers)) {
    if (p.sharing) sharing.push({ id, name: p.nickname, self: false })
  }

  const pinned = Object.entries(snap.peers).filter(([, p]) => p.pinned)
  const showPin = pinned.length > 0
  const cols = gridCols(sharing.length)

  return (
    <div className="flex-1 min-w-0 relative bg-background flex flex-col">
      {!inRoom && (
        <div className="flex-1 flex flex-col items-center justify-center gap-md text-tip">
          <div className="text-[52px] opacity-40">🏠</div>
          <div>从左侧选择一个房间加入</div>
          <div className="text-xs opacity-70">点击房间名即可进入，也可将大厅里的人拖到房间中</div>
        </div>
      )}

      {inRoom && showPin && (
        <div className="absolute inset-0 p-lg grid gap-lg overflow-auto grid-cols-[repeat(auto-fit,minmax(340px,1fr))] content-start bg-background z-[2]">
          {pinned.map(([id, p]) => (
            <PinTile key={id} id={id} name={p.nickname} />
          ))}
        </div>
      )}

      {/* 中央大屏：直接以网格展示所有正在共享的成员 */}
      {inRoom && sharing.length > 0 && (
        <div
          className={`absolute inset-0 p-lg grid gap-lg overflow-auto content-start bg-background${showPin ? " hidden" : ""}`}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {sharing.map((s) => (
            <ShareTile
              key={s.id}
              id={s.id}
              name={s.name}
              isSelf={s.self}
              playing={s.self || !!snap.peers[s.id]?.playing}
              pinned={!!snap.peers[s.id]?.pinned}
            />
          ))}
        </div>
      )}

      {/* 无人共享：显示自己的画面（共享预览） */}
      {inRoom && sharing.length === 0 && (
        <div className={`absolute inset-0 flex items-center justify-center [transform:translateZ(0)]${showPin ? " hidden" : ""}`}>
          <video
            ref={selfVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-contain bg-black"
          ></video>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-sm text-tip pointer-events-none">
            <div className="text-[46px] opacity-50">🖥</div>
            <div>你尚未共享屏幕</div>
            <div className="text-xs opacity-70">点击下方"共享屏幕"即可开始</div>
          </div>
          <div className="absolute left-sm bottom-sm flex gap-sm items-center px-sm py-xs sc-glass rounded-lg text-xs">
            <span className={snap.talkingSet.has(snap.myId) ? "talking" : ""}>
              {snap.myNick}（我）
            </span>
            <span className="px-sm py-ty rounded-[6px] text-[11px] bg-accent/30 text-tip">
              本机
            </span>
          </div>
        </div>
      )}

      {inRoom && showPin && (
        <div className="absolute left-lg bottom-lg px-md py-sm sc-glass rounded-lg text-xs text-tip z-[3]">
          已固定 <b>{pinned.length}</b> 个画面 · 在成员右键菜单或瓦片点"⤢"可固定/取消
        </div>
      )}
    </div>
  )
}
