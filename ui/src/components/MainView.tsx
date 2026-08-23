import { useEngine } from "../hooks"
import Sidebar from "./Sidebar"
import Stage from "./Stage"
import LobbySidebar from "./LobbySidebar"
import AsrPanel from "./AsrPanel"
import PeerAudioHost from "./PeerAudioHost"

export default function MainView() {
  const snap = useEngine()

  return (
    <section className="w-screen h-screen flex flex-col overflow-hidden">
      <div className="flex-1 flex min-h-0 divide-x divide-line">
        <Sidebar />
        <Stage />
        {/* ASR 面板：只有房间开启转写模式时才出现（替代原浮动弹窗） */}
        {snap.asrActive && snap.room && <AsrPanel />}
        <LobbySidebar />
      </div>

      {/* 隐藏音频层：保证移除成员面板后仍能听到对方声音 */}
      <PeerAudioHost />
    </section>
  )
}
