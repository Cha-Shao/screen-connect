import { useEngine } from "../hooks"
import { engine } from "../engine"

export default function Modal() {
  const snap = useEngine()
  const modal = snap.modal
  if (!modal) return null

  const isSpinner = !!modal.spinner

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px]"
        onClick={() => {
          if (!isSpinner) engine.hideModal()
        }}
      ></div>
      <div className="relative w-[min(420px,90vw)] bg-panel border border-line rounded-2xl px-2xl pt-2xl pb-xl text-center shadow-2xl animate-sc-modal">
        {isSpinner ? (
          <div className="w-9 h-9 rounded-full border-[3px] border-accent/20 border-t-accent animate-sc-spin mx-auto mb-md"></div>
        ) : (
          <div className="text-4xl mb-md">{modal.icon}</div>
        )}
        <div className="text-lg font-semibold mb-sm">{modal.title}</div>
        <div
          className="text-tip text-sm mb-xl leading-relaxed"
          dangerouslySetInnerHTML={{ __html: modal.body ?? "" }}
        ></div>
        {modal.actions.length > 0 && (
          <div className="flex flex-wrap gap-md justify-center">
            {modal.actions.map((a, i) => (
              <button
                key={i}
                className={a.cancel ? "btn btn-ghost btn-sm" : "btn btn-primary btn-sm"}
                onClick={() => {
                  engine.hideModal()
                  a.onClick && a.onClick()
                }}
              >
                {a.text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
