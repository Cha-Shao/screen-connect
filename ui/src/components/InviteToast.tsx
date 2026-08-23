import { useEngine } from "../hooks"
import { engine } from "../engine"

/** 右下角邀请弹窗：不自动关闭，直到用户点"接受/拒绝" */
export default function InviteToast() {
  const snap = useEngine()
  const invites = snap.invites || []
  if (invites.length === 0) return null

  return (
    <div className="fixed right-xl bottom-xl z-[9600] flex flex-col gap-sm w-[min(320px,88vw)]">
      {invites.map((inv) => (
        <div
          key={inv.key}
          className="bg-panel2 border border-line rounded-xl px-lg py-md shadow-2xl animate-sc-invite"
        >
          <div className="flex items-start gap-md">
            <span className="text-xl leading-none">✉️</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text">
                <b>{inv.fromNick}</b> 邀请你加入房间
              </div>
              <div className="text-[13px] text-accent mt-ty truncate">
                「{inv.roomName}」
              </div>
            </div>
          </div>
          <div className="mt-md flex gap-sm justify-end">
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => engine.dismissInvite(inv.key)}
            >
              拒绝
            </button>
            <button
              className="btn btn-xs btn-primary"
              onClick={() => engine.acceptInvite(inv.key)}
            >
              接受
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
