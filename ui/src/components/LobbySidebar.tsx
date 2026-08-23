import { useEngine } from "../hooks"
import { engine, type UserInfo } from "../engine"

/**
 * 单行用户：绿点=在房间，灰点=在大厅。不显示讲话状态。
 * hover 可邀请（仅对大厅用户显示邀请按钮，房间内成员已在房间里无需邀请）。
 */
interface UserRowProps {
  u: UserInfo
  isMe: boolean
  invite?: (u: UserInfo) => void
}

function UserRow({ u, isMe, invite }: UserRowProps) {
  const inRoom = !!u.roomId
  return (
    <div className="group flex items-center gap-sm px-md py-sm rounded-lg select-none transition-colors hover:bg-panel2">
      <span className={`w-sm h-sm rounded-full shrink-0${inRoom ? " bg-success" : " bg-muted"}`}></span>
      <span className="text-[13px] flex-1 min-w-0 truncate space-x-xs">
        <span>{u.nickname}</span>
        {isMe && <span className="px-sm bg-muted/20 rounded-full text-xs text-tip">我</span>}
      </span>
      {!isMe && invite && (
        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-[11px] px-sm py-ty rounded-md border border-line bg-panel2 text-tip cursor-pointer hover:border-accent hover:text-text shrink-0"
          title="邀请加入我的房间"
          onClick={(e) => {
            e.stopPropagation()
            invite(u)
          }}
        >
          邀请
        </button>
      )}
    </div>
  )
}

/**
 * 右侧常驻的在线大厅：
 * - 不显示谁在讲话；
 * - 只详细列出「我所在房间」的全部成员；
 * - 其他我没加入的房间只显示人数（有人），不列成员、不关心那边发生了什么；
 * - 大厅（未进房间）的人照常显示，hover 可邀请。
 */
export default function LobbySidebar() {
  const snap = useEngine()

  const users = snap.allUsers || []
  const myRoomId = snap.room // 当前用户所在房间（"" 表示在大厅）
  const myRoomUsers = myRoomId ? users.filter((u) => u.roomId === myRoomId) : []
  const inLobby = users.filter((u) => !u.roomId)
  const inOtherRooms = users.filter((u) => u.roomId && u.roomId !== myRoomId)

  // 其他房间：只统计人数，不列成员
  const roomMap: Record<string, { name: string; count: number }> = {}
  for (const u of inOtherRooms) {
    if (!roomMap[u.roomId!]) roomMap[u.roomId!] = { name: "", count: 0 }
    roomMap[u.roomId!].count++
  }
  for (const rd of snap.roomDefs || []) {
    if (roomMap[rd.id]) roomMap[rd.id].name = rd.name
  }
  const roomGroups = Object.entries(roomMap).map(([roomId, g]) => ({
    roomId,
    count: g.count,
    name: g.name || roomId,
  }))

  const invite = (u: UserInfo) => engine.inviteUser(u.id, u.nickname)

  return (
    <aside className="w-[250px] flex-[0_0_250px] flex flex-col bg-panel">
      <div className="flex items-center justify-between px-lg py-md text-xs text-tip uppercase tracking-[0.5px] border-b border-line shrink-0">
        <span>在线大厅</span>
        <span className="normal-case text-[11px]">{users.length} 人在线</span>
      </div>

      <div className="flex-1 overflow-y-auto p-sm">
        {/* 我所在的房间：显示全部成员 */}
        {myRoomId && (
          <>
            <div className="px-sm pt-xs pb-xs text-[11px] text-tip truncate shrink-0">
              🏠 {snap.roomName || myRoomId}（我的房间）
            </div>
            {myRoomUsers.map((u) => (
              <UserRow key={u.id} u={u} isMe={u.id === snap.myId} />
            ))}
          </>
        )}

        {/* 其他我没加入的房间：只显示有人，不列成员 */}
        {roomGroups.map((g) => (
          <div
            key={g.roomId}
            className="flex items-center justify-between gap-sm px-md py-sm rounded-lg select-none"
          >
            <span className="text-[13px] truncate min-w-0">🏠 {g.name}</span>
            <span className="text-[11px] text-tip shrink-0">👥 {g.count} 人在线</span>
          </div>
        ))}

        {/* 大厅（未进房间） */}
        {inLobby.length > 0 && (
          <>
            <div className="px-sm pt-xs pb-xs text-[11px] text-tip shrink-0">
              大厅（未进房间）
            </div>
            {inLobby.map((u) => (
              <UserRow key={u.id} u={u} isMe={u.id === snap.myId} invite={invite} />
            ))}
          </>
        )}

        {users.length === 0 && (
          <div className="py-lg text-center text-tip text-xs">暂无在线用户</div>
        )}
      </div>
    </aside>
  )
}
