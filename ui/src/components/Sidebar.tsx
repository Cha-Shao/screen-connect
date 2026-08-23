import { useEffect, useRef, useState, type DragEvent } from "react"
import { useEngine } from "../hooks"
import { engine, ENGINE_NAMES, type Snapshot, type UserInfo } from "../engine"
import Controls from "./Controls"

interface MemberMenuState {
  x: number
  y: number
  uid: string
  nickname: string
}

/** 成员右键菜单：音量 + （共享时）播放/放大/全屏；不在同一房间时提供邀请 */
function MemberMenu({
  menu,
  onClose,
}: {
  menu: MemberMenuState
  onClose: () => void
}) {
  const snap = useEngine()
  const [vol, setVol] = useState<number>(() => {
    const v = engine.peerVolumes[menu.uid]
    return v != null ? v : 100
  })
  const peer = snap.peers[menu.uid]

  // 点击别处 / 滚动关闭
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

  const x = Math.max(8, Math.min(menu.x, window.innerWidth - 230))
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - 220))

  return (
    <div
      className="fixed z-[9000] w-[210px] bg-panel2 border border-line rounded-lg shadow-2xl p-sm flex flex-col gap-sm"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="px-md py-xs text-[12px] font-semibold truncate">
        {menu.nickname}
        <span className="ml-sm text-[10px] font-normal text-tip">
          {peer ? "（同一房间）" : "（不在同一房间）"}
        </span>
      </div>

      {peer ? (
        <>
          <div className="flex items-center gap-sm px-md py-xs">
            <span className="text-sm">🔊</span>
            <input
              type="range"
              min={0}
              max={100}
              value={vol}
              className="flex-1 accent-accent h-xs"
              onChange={(e) => {
                const v = Number(e.target.value)
                setVol(v)
                engine.setPeerVolume(menu.uid, v)
              }}
            />
            <span className="w-[30px] text-right tabular-nums text-xs text-text">
              {vol}
            </span>
          </div>
          {peer.sharing && (
            <div className="flex gap-sm px-md pb-sm">
              <button
                className={`flex-1 py-sm px-sm rounded-lg border border-line bg-panel text-text cursor-pointer text-xs hover:border-accent${peer.playing ? " peer-btn-active-play" : ""}`}
                onClick={() => engine.togglePlay(menu.uid)}
              >
                {peer.playing ? "⏸ 暂停" : "▶ 播放"}
              </button>
              <button
                className={`flex-1 py-sm px-sm rounded-lg border border-line bg-panel text-text cursor-pointer text-xs hover:border-accent${peer.pinned ? " peer-btn-active-pin" : ""}`}
                onClick={() => engine.togglePin(menu.uid)}
              >
                {peer.pinned ? "✕ 取消放大" : "⤢ 窗口放大"}
              </button>
              <button
                className="flex-1 py-sm px-sm rounded-lg border border-line bg-panel text-text cursor-pointer text-xs hover:border-accent"
                onClick={() => engine.togglePeerFullscreen(menu.uid)}
              >
                ⛶ 全屏
              </button>
            </div>
          )}
          {!peer.sharing && (
            <div className="px-md pb-sm text-[11px] text-tip">
              该成员当前未共享画面
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-sm px-md pb-sm">
          <div className="text-[11px] text-tip">加入同一房间后可调节音量</div>
          <button
            className="btn btn-xs btn-primary"
            onClick={() => engine.inviteUser(menu.uid, menu.nickname)}
          >
            邀请加入我的房间
          </button>
        </div>
      )}
    </div>
  )
}

export default function Sidebar() {
  const snap = useEngine()
  const dragging = useRef(false)
  const [frozen, setFrozen] = useState<Snapshot | null>(null)
  const [menu, setMenu] = useState<MemberMenuState | null>(null)
  // 拖拽中冻结快照：避免引擎更新（如 user-list）重建 DOM 中断拖拽
  const view = dragging.current && frozen ? frozen : snap

  const onDragStart = (e: React.DragEvent<HTMLSpanElement>, uid: string) => {
    dragging.current = true
    setFrozen(snap)
    e.dataTransfer.setData("text/plain", uid)
    e.dataTransfer.effectAllowed = "move"
  }
  const onDragEnd = () => {
    dragging.current = false
    setFrozen(null)
  }

  const rooms = view.roomDefs || []
  const inRoom = !!view.room
  const asrGlobal = view.asrInfo

  return (
    <aside className="relative w-[280px] flex-[0_0_280px] flex flex-col bg-panel overflow-hidden">
      <div className="flex flex-col min-h-0 flex-1 divide-y divide-line">
        <div className="px-lg py-md text-xs text-tip uppercase tracking-[0.5px] shrink-0">
          <span>房间列表</span>
        </div>
        {/* 列表留出 padding：与下方控制卡片形成"悬浮"间距 */}
        <div className="flex-1 overflow-y-auto px-md py-md">
          {rooms.map((rd) => {
            const isActive = view.room === rd.id
            const usersInRoom = view.allUsers.filter(
              (u: UserInfo) => u.roomId === rd.id,
            )
            const roomAsrOn = !!view.roomAsr[rd.id]
            const showASRButton = !isActive || !asrGlobal || !asrGlobal.enabled
            let asrTitle = "语音转写（ASR）：引擎由服务器配置决定"
            if (!isActive) {
              asrTitle = "加入该房间后可开关转写"
            } else if (!asrGlobal || !asrGlobal.enabled) {
              asrTitle = "服务器未启用语音转写（ASR）"
            } else {
              const name = ENGINE_NAMES[asrGlobal.mode] || "?"
              asrTitle = `语音转写（引擎：${name}${asrGlobal.ready ? "" : "，未就绪"}）`
            }
            // 未加入的房间：<button>（点击加入、可聚焦）；已加入的房间：<div>
            // （没有加入操作了，且转写开关按钮在内部，避免 button 嵌套）
            const roomCls = `py-sm px-md rounded-[10px] mb-xs border transition-colors${
              isActive
                ? " bg-accent/15 border-accent/40"
                : " cursor-pointer border-transparent hover:bg-panel2"
            }`
            const dropProps = {
              onDragOver: (e: DragEvent<HTMLElement>) => {
                e.preventDefault()
                e.currentTarget.classList.add("room-item-drag-over")
              },
              onDragLeave: (e: DragEvent<HTMLElement>) =>
                e.currentTarget.classList.remove("room-item-drag-over"),
              onDrop: (e: DragEvent<HTMLElement>) => {
                e.preventDefault()
                e.currentTarget.classList.remove("room-item-drag-over")
                const uid = e.dataTransfer.getData("text/plain")
                if (uid) engine.moveUserToRoom(uid, rd.id, rd.name)
              },
            }
            const roomContent = (
              <>
                <span className="flex items-center gap-sm">
                  <span className="flex-1 min-w-0 truncate">
                    {rd.name}
                    {roomAsrOn && (
                      <span className="ml-sm px-sm py-ty rounded-[5px] text-[9px] font-bold bg-success/20 text-tip border border-success/40 align-middle">
                        ASR
                      </span>
                    )}
                  </span>
                  {!showASRButton && (
                    <button
                      className={`btn btn-xs btn-ghost gap-sm normal-case shrink-0${roomAsrOn ? " btn-success" : ""}`}
                      title={asrTitle}
                      onClick={(e) => {
                        e.stopPropagation()
                        engine.toggleAsr()
                      }}
                    >
                      <span className="text-sm">📝</span>
                      <span>{roomAsrOn ? "转写中" : "转写"}</span>
                    </button>
                  )}
                </span>
                {rd.desc && (
                  <span className="block text-[11px] text-tip mt-ty overflow-hidden text-ellipsis whitespace-nowrap">
                    {rd.desc}
                  </span>
                )}
                {usersInRoom.length > 0 && (
                  <>
                    <span className="block text-[10px] text-tip mt-xs">
                      {usersInRoom.length} 人
                    </span>
                    <span className="mt-sm flex flex-col gap-xs">
                      {usersInRoom.map((u) => {
                        const isMe = u.id === view.myId
                        return (
                          <span
                            key={u.id}
                            draggable={!isMe}
                            title={
                              isMe
                                ? "你（右键他人可调音量）"
                                : "左键拖动到其他房间 · 右键菜单"
                            }
                            className={`text-[11px] py-xs px-md rounded-md drag-el block select-none${isMe ? " bg-success/20" : " bg-accent/15 cursor-grab active:cursor-grabbing"}${view.talkingSet.has(u.id) ? " talking" : ""}`}
                            onDragStart={(e) => onDragStart(e, u.id)}
                            onDragEnd={onDragEnd}
                            onContextMenu={(e) => {
                              if (isMe) return
                              e.preventDefault()
                              e.stopPropagation()
                              setMenu({
                                x: e.clientX,
                                y: e.clientY,
                                uid: u.id,
                                nickname: u.nickname,
                              })
                            }}
                          >
                            {u.nickname}
                          </span>
                        )
                      })}
                    </span>
                  </>
                )}
              </>
            )
            return isActive ? (
              <div key={rd.id} className={roomCls} {...dropProps}>
                {roomContent}
              </div>
            ) : (
              <button
                key={rd.id}
                type="button"
                className={roomCls + " w-full text-left"}
                onClick={() => engine.joinRoomById(rd.id, rd.name)}
                {...dropProps}
              >
                {roomContent}
              </button>
            )
          })}
        </div>
      </div>

      {/* 底部微光：给毛玻璃卡片一点可模糊的背景层次 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-accent/10 via-accent/5 to-transparent" />

      {/* 控制栏卡片：悬浮在房间列表下方 */}
      <div className="relative shrink-0 p-md pt-0">
        <Controls />
      </div>

      {menu && (
        <MemberMenu key={menu.uid} menu={menu} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}
