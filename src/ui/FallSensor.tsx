import type React from "react"
import {useEffect, useRef, useState} from "react"

type Sample = {m: number; peak: number; at: number}
const SPAN_MS = 10_000
const MAX_G = 4
/** Same thresholds the detector uses (src/background/fall.ts), drawn so you can see what would trigger it. */
const FREE_FALL_G = 0.5
const IMPACT_G = 2.5

/** Live accelerometer view: magnitude over the last 10 seconds, the x/y/z numbers, and whether data is arriving at all. */
export function FallSensor(): React.JSX.Element {
  const [last, setLast] = useState<{x: number; y: number; z: number; m: number; simulated: boolean} | null>(null)
  const [status, setStatus] = useState("Waiting for accelerometer data…")
  const [head, setHead] = useState("")
  const [rate, setRate] = useState(0)
  const samples = useRef<Sample[]>([])
  const count = useRef(0)
  const lastAt = useRef(0)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const offs = [
      mentra.on("p0:accel", (a) => {
        samples.current.push({m: a.m, peak: a.peak, at: a.at})
        samples.current = samples.current.filter((s) => a.at - s.at < SPAN_MS)
        count.current++
        lastAt.current = a.at
        setLast({x: a.x, y: a.y, z: a.z, m: a.m, simulated: a.simulated})
        setStatus(a.simulated ? "SIMULATED data (not from the glasses)" : "Streaming from the glasses")
      }),
      mentra.on("p0:imu", (i) => {
        if (i.head) setHead(i.head)
        if (!samples.current.length) setStatus(i.status)
      }),
    ]
    const tick = setInterval(() => {
      setRate(count.current)
      count.current = 0
      if (lastAt.current && Date.now() - lastAt.current > 3000) setStatus("Data stopped")
      draw()
    }, 1000)
    const fast = setInterval(draw, 120)
    return () => {
      offs.forEach((o) => o())
      clearInterval(tick)
      clearInterval(fast)
    }
  }, [])

  function draw() {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext("2d")
    if (!ctx) return
    const w = c.width, h = c.height
    const y = (g: number) => h - (Math.min(g, MAX_G) / MAX_G) * (h - 6) - 3
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = "#f5f9f8"
    ctx.fillRect(0, 0, w, h)
    // reference lines: rest (1 g), free-fall and impact thresholds
    const line = (g: number, color: string, label: string) => {
      ctx.strokeStyle = color
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(0, y(g)); ctx.lineTo(w, y(g)); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color; ctx.font = "10px sans-serif"; ctx.fillText(label, 3, y(g) - 2)
    }
    line(1, "#4e7e6d", "1 g (resting)")
    line(FREE_FALL_G, "#f2b655", "free-fall below 0.5 g")
    line(IMPACT_G, "#b8372b", "impact above 2.5 g")
    const s = samples.current
    if (!s.length) return
    const now = Date.now()
    const x = (at: number) => w - ((now - at) / SPAN_MS) * w
    ctx.strokeStyle = "#244b45"; ctx.lineWidth = 2
    ctx.beginPath()
    s.forEach((p, i) => (i ? ctx.lineTo(x(p.at), y(p.peak)) : ctx.moveTo(x(p.at), y(p.peak))))
    ctx.stroke(); ctx.lineWidth = 1
  }

  return (
    <div>
      <h2>Fall sensor</h2>
      <p><b>{status}</b>{rate ? ` · ${rate} updates/s` : ""}{head ? ` · head ${head}` : ""}</p>
      <canvas ref={canvas} width={340} height={150} style={{width: "100%", border: "1px solid #d3e3df", borderRadius: 8}} />
      {last ? (
        <p style={{fontFamily: "monospace"}}>
          x {last.x.toFixed(2)} · y {last.y.toFixed(2)} · z {last.z.toFixed(2)} · <b>{last.m.toFixed(2)} g</b>
        </p>
      ) : (
        <p>No readings yet. If this stays empty, the glasses do not stream an accelerometer (the SDK lists it as G2 only), and fall response is voice-only.</p>
      )}
      <button type="button" onClick={() => mentra.send("engine:simFall", {})}>Simulate fall (starts a real check-in)</button>
    </div>
  )
}
