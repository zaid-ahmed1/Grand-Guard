import type React from "react"
import {useEffect, useState} from "react"
import type {PhotoCompress, PhotoSize} from "../shared/channels"

type Photo = {url: string; mimeType: string; bytes: number; latencyMs: number; size: string; compress: string}

export function App(): React.JSX.Element {
  const [logs, setLogs] = useState<string[]>([])
  const [backend, setBackend] = useState("")
  const [sim, setSim] = useState("He says I must buy gift cards right now and not tell anyone")
  const [lines, setLines] = useState<string[]>([])
  const [interim, setInterim] = useState("")
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [size, setSize] = useState<PhotoSize>("low")
  const [compress, setCompress] = useState<PhotoCompress>("medium")
  const [say, setSay] = useState("This looks like a scam. Don't pay or give any codes.")

  useEffect(() => {
    const offs = [
      mentra.on("p0:log", ({at, msg}) =>
        setLogs((l) => [`${new Date(at).toLocaleTimeString()} ${msg}`, ...l].slice(0, 40)),
      ),
      mentra.on("p0:transcript", (t) => {
        if (t.isFinal) {
          setLines((l) => [`${t.text}  [${t.source ?? "?"}, +${t.latencyMs}ms]`, ...l].slice(0, 15))
          setInterim("")
        } else setInterim(t.text)
      }),
      mentra.on("p0:photoResult", setPhoto),
      mentra.on("engine:backend", ({url}) => setBackend(url)),
    ]
    return () => offs.forEach((o) => o())
  }, [])

  return (
    <div className="app">
      <h1>Grand Guard (debug)</h1>

      <h2>Engine</h2>
      <input value={backend} placeholder="http://<laptop-LAN-IP>:8787" onChange={(e) => setBackend(e.target.value)} style={{width: "100%"}} />
      <button type="button" onClick={() => mentra.send("engine:setBackend", {url: backend})}>Save backend URL</button>
      <input value={sim} onChange={(e) => setSim(e.target.value)} style={{width: "100%"}} />
      <button type="button" onClick={() => mentra.send("engine:simulate", {text: sim})}>Simulate trigger</button>
      <h3>Live transcript</h3>
      {interim && <p><i>{interim}</i></p>}
      {lines.map((l, i) => <p key={i}>{l}</p>)}

      <h2>B. Photo</h2>
      <select value={size} onChange={(e) => setSize(e.target.value as PhotoSize)}>
        {["low", "medium", "high", "max"].map((s) => <option key={s}>{s}</option>)}
      </select>
      <select value={compress} onChange={(e) => setCompress(e.target.value as PhotoCompress)}>
        {["none", "low", "medium", "high"].map((s) => <option key={s}>{s}</option>)}
      </select>
      <button type="button" onClick={() => mentra.send("p0:photo", {size, compress})}>Take photo</button>
      {photo && (
        <div>
          <p>{photo.size}/{photo.compress}: {photo.bytes} B, {photo.latencyMs} ms</p>
          <img src={photo.url} style={{maxWidth: "100%"}} />
        </div>
      )}

      <h2>D. TTS whisper</h2>
      <input value={say} onChange={(e) => setSay(e.target.value)} style={{width: "100%"}} />
      {(["preferCloud", "preferLocal", "localOnly"] as const).map((processing) => (
        <button key={processing} type="button" onClick={() => mentra.send("p0:speak", {text: say, processing})}>
          Speak ({processing})
        </button>
      ))}

      <h2>Log</h2>
      <pre style={{fontSize: 11, whiteSpace: "pre-wrap"}}>{logs.join("\n")}</pre>
    </div>
  )
}
