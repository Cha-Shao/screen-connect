import { useEffect, useState } from "react"
import { useEngine } from "./hooks"
import { engine } from "./engine"
import MainView from "./components/MainView"
import Lobby from "./components/Lobby"
import Modal from "./components/Modal"
import Toast from "./components/Toast"
import InviteToast from "./components/InviteToast"

export default function App() {
  const snap = useEngine()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    engine.init()
    // 隐藏加载动画（React 已挂载，splash 使命完成）
    const s = document.getElementById("splash")
    if (s) {
      s.style.opacity = "0"
      setTimeout(() => s.remove(), 350)
    }
    setMounted(true)
  }, [])

  if (!mounted) return null

  return (
    <>
      {snap.connected ? <MainView /> : <Lobby />}
      <Modal />
      <Toast />
      <InviteToast />
    </>
  )
}
