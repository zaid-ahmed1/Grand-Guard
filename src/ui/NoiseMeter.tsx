import type React from "react"
import {useEffect, useRef, useState} from "react"
import {PEAK_DB} from "../background/loudness"

/** Live loudness meter for tuning the loud-noise trigger. Shows levels only, never audio. */
export function NoiseMeter(): React.JSX.Element {
  const [lvl, setLvl] = useState<{rmsDb: number; peakDb: number; roomDb: number} | null>(null)
  const [status, setStatus] = useState("Off")
  const [on, setOn] = useState(false)
  const hold = useRef(-90)

  useEffect(() => {
    const offOn = mentra.on("engine:noise", ({on}) => setOn(on))
    const off = mentra.on("p0:level", (l) => {
      if (l.status) return setStatus(l.status)
      setStatus(l.calibrating !== undefined ? `Learning the room's normal noise… ${l.calibrating} s (stay at your normal level)` : "Listening for a loud noise")
      hold.current = Math.max(l.peakDb, hold.current - 1.5)
      setLvl({rmsDb: l.rmsDb, peakDb: l.peakDb, roomDb: l.roomDb})
    })
    return () => { off(); offOn() }
  }, [])

  const pct = (d: number) => `${Math.max(0, Math.min(100, ((d + 60) / 60) * 100))}%`
  return (
    <div>
      <h2>Loud-noise fall trigger (experimental)</h2>
      <label style={{display: "flex", gap: 10, alignItems: "center", fontSize: 18, fontWeight: 700}}>
        <input type="checkbox" checked={on} style={{width: 26, height: 26}} onChange={(e) => { setOn(e.target.checked); setLvl(null); setStatus(e.target.checked ? "Starting…" : "Off"); mentra.send("engine:setNoise", {on: e.target.checked}) }} />
        {on ? "ON" : "OFF"}
      </label>
      <p><b>{status}</b></p>
      <div style={{position: "relative", height: 22, background: "#e4f2ef", borderRadius: 6, overflow: "hidden"}}>
        <div style={{position: "absolute", inset: 0, width: pct(on ? lvl?.peakDb ?? -90 : -90), background: "#4e7e6d"}} />
        <div style={{position: "absolute", top: 0, bottom: 0, left: pct(PEAK_DB), width: 3, background: "#b8372b"}} title="trigger level" />
      </div>
      {on && lvl && (
        <p style={{fontFamily: "monospace", fontSize: 12}}>
          peak {lvl.peakDb.toFixed(0)} dB · average {lvl.rmsDb.toFixed(0)} dB · room {lvl.roomDb.toFixed(0)} dB · trigger at peak above {PEAK_DB} dB (red line)
        </p>
      )}
      <button type="button" onClick={() => mentra.send("engine:simNoise", {})}>Simulate loud noise (starts a real check-in)</button>
    </div>
  )
}
