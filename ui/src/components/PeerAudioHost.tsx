import { useEffect, useRef } from "react"
import { useEngine } from "../hooks"
import { engine } from "../engine"

/** 每个对端一个隐藏 <audio>：保证移除成员面板后仍能听到对方声音 */
function PeerAudio({ id }: { id: string }) {
  const ref = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    engine.registerPeerEls(id, { audio: ref.current ?? undefined })
    return () => engine.unregisterPeerEls(id, ["audio"])
  }, [id])

  return <audio ref={ref} autoPlay style={{ display: "none" }} />
}

/** 隐藏音频层：为当前房间所有对端渲染 <audio> 元素（display:none 不影响播放） */
export default function PeerAudioHost() {
  const snap = useEngine()
  const peers = Object.keys(snap.peers)
  if (peers.length === 0) return null
  return (
    <div aria-hidden>
      {peers.map((id) => (
        <PeerAudio key={id} id={id} />
      ))}
    </div>
  )
}
