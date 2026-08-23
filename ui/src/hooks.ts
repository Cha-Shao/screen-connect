import { useEffect, useState } from "react"
import { engine, type Snapshot } from "./engine"

/** 订阅引擎快照：任何引擎状态变更都会触发重渲染 */
export function useEngine(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(() => engine.snapshot)
  useEffect(() => engine.subscribe(setSnap), [])
  return snap
}
