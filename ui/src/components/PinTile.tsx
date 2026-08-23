import { useEffect, useRef } from "react"
import { engine } from "../engine"

interface PinTileProps {
  id: string
  name: string
}

export default function PinTile({ id, name }: PinTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    engine.registerPinEl(id, videoRef.current)
    return () => engine.unregisterPinEl(id)
  }, [id])

  return (
    <div className="relative bg-black rounded-xl overflow-hidden border border-line aspect-video [transform:translateZ(0)]">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-contain bg-black"
      ></video>
      <div className="absolute left-sm top-sm px-sm py-xs sc-glass rounded-lg text-xs">
        {name}
      </div>
      <button
        className="absolute right-sm top-sm text-xs px-sm py-xs sc-glass rounded-lg cursor-pointer"
        onClick={() => engine.togglePin(id)}
      >
        ✕ 取消
      </button>
    </div>
  )
}
