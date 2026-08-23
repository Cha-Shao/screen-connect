import { useEngine } from "../hooks"

export default function Toast() {
  const snap = useEngine()
  if (!snap.toastMsg) return null
  return (
    <div
      key={snap.toastMsg}
      className="fixed top-xl left-1/2 -translate-x-1/2 z-[9500] px-xl py-md rounded-[10px] bg-panel2 border border-line text-text text-sm shadow-2xl max-w-[90vw] animate-sc-toast"
    >
      {snap.toastMsg}
    </div>
  )
}
