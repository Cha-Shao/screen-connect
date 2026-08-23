import { useState } from "react"
import { useEngine } from "../hooks"
import { engine } from "../engine"
import { AuroraBackground } from "./AuroraBackground"

export default function Lobby() {
  const snap = useEngine()
  const [copied, setCopied] = useState(false)

  const doCopy = async () => {
    const ok = await engine.copyId()
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }

  return (
    <AuroraBackground className="min-h-screen">
      <section className="card relative space-y-lg bg-panel shadow-2xl w-[min(560px,92vw)] max-h-[92vh] overflow-auto p-2xl rounded-2xl border border-muted">
        <div>
          <h1 className="m-none mb-xs text-[26px] tracking-[0.5px]">
            ScreenConnect
          </h1>
          <p className="m-none text-tip">连接服务器，选择房间加入</p>
        </div>

        <label className="flex flex-col gap-sm text-tip text-[13px]">
          信令服务器（域名:端口）
          <div className="flex gap-md items-center">
            <input
              type="text"
              className="input w-full flex-1"
              placeholder="公网IP或域名（默认端口1454）"
              autoComplete="off"
              value={snap.serverHost}
              onChange={(e) => engine.setForm({ serverHost: e.target.value })}
            />
            <label
              className="flex items-center gap-sm m-none text-tip text-[13px] cursor-pointer whitespace-nowrap select-none"
              title="服务器若套了 TLS/反代则勾选"
            >
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={snap.wssChecked}
                onChange={(e) =>
                  engine.setForm({ wssChecked: e.target.checked })
                }
              />
              wss
            </label>
          </div>
        </label>

        <label className="flex flex-col gap-sm text-tip text-[13px]">
          昵称
          <input
            type="text"
            className="input w-full"
            maxLength={24}
            placeholder="给自己起个名字"
            autoComplete="off"
            value={snap.nick}
            onChange={(e) => engine.setForm({ nick: e.target.value })}
          />
        </label>

        <div className="flex items-center gap-sm py-md px-md bg-panel2 border border-dashed border-line rounded-[10px]">
          <span className="text-tip text-xs mr-auto">
            机器码（你的唯一 ID）
          </span>
          <code className="font-mono text-tip text-[13px]">
            {snap.myId || "读取中…"}
          </code>
          <button
            className="btn btn-xs btn-ghost"
            title="复制"
            onClick={doCopy}
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>

        <button
          className="btn btn-primary w-full"
          onClick={() => engine.connectServer()}
        >
          连接服务器
        </button>
        {snap.lobbyMsg && (
          <p className="min-h-4.5 text-warn text-[13px]">
            {snap.lobbyMsg}
          </p>
        )}
      </section>
    </AuroraBackground>
  )
}
