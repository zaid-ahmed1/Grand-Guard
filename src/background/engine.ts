/**
 * Engine (spec §5): Trigger → Capture → Check → Whisper → Notify.
 * Owns always-on local STT, the rolling transcript window, triggers and cooldowns.
 * The transcript lives in memory only and is never persisted.
 */
import type {MiniappSession} from "@mentra/miniapp/background"
import type {AnalyzeRequest, Verdict} from "../shared/types"
import type {Channels} from "../shared/channels"

type Session = MiniappSession<Channels>

const WINDOW_MS = 60_000
const COOLDOWN_MS = 30_000
// Inlined at build time by `define`; the bare JS engine has no `process` global, so guard it.
const DEFAULT_BACKEND: string = typeof process !== "undefined" ? (process.env.MENTRA_PUBLIC_BACKEND_URL ?? "") : ""

/** Cheap local triggers. The backend LLM makes the real call. */
const SCAM_TRIGGERS: RegExp[] = [
  /gift ?cards?/i,
  /wire (the )?(money|transfer)|wire transfer/i,
  /bitcoin|crypto(currency)? atm|crypto/i,
  /don'?t tell (anyone|anybody|your)/i,
  /remote access|anydesk|teamviewer/i,
  /your (computer|device) (has|is|was).{0,20}(virus|infected|hacked)/i,
  /\b(irs|social security|medicare)\b.{0,40}(owe|arrest|suspend|call|problem)/i,
]
const SCAM_COMMAND = /is this a scam|check (this|that) (for a scam|scam)|scam check/i

export class Engine {
  private window: {at: number; text: string}[] = []
  private busy = false
  private lastRun = 0
  private backendUrl = DEFAULT_BACKEND

  constructor(private session: Session) {}

  private log(msg: string) {
    console.log(`[engine] ${msg}`)
    this.session.ui.send("p0:log", {at: Date.now(), msg})
  }

  async start() {
    const stored = await this.session.storage.get("backendUrl")
    if (stored) this.backendUrl = stored
    this.log(`backend: ${this.backendUrl || "NOT SET"}`)

    this.session.ui.on("engine:setBackend", async ({url}) => {
      this.backendUrl = url.replace(/\/$/, "")
      await this.session.storage.set("backendUrl", this.backendUrl)
      this.log(`backend set to ${this.backendUrl}`)
    })
    this.session.ui.on("engine:simulate", ({text}) => this.ingest(text, true))
    this.session.ui.onOpen(() => this.session.ui.send("engine:backend", {url: this.backendUrl}))

    // Local-only STT: audio never leaves the phone, only text goes to the backend.
    this.session.transcription.on((d) => {
      this.session.ui.send("p0:transcript", {text: d.text, isFinal: d.isFinal, source: d.source, latencyMs: 0})
      if (d.isFinal) this.ingest(d.text, false)
    }, {processing: "localOnly"})
    this.log("engine listening (localOnly STT)")
  }

  private ingest(text: string, forced: boolean) {
    const now = Date.now()
    this.window.push({at: now, text})
    this.window = this.window.filter((w) => now - w.at <= WINDOW_MS)

    const command = SCAM_COMMAND.test(text)
    const trigger = SCAM_TRIGGERS.find((re) => re.test(text))
    if (!command && !trigger && !forced) return
    void this.run(command ? "voice command" : `phrase ${trigger ?? "simulated"}`, command || forced)
  }

  private async run(reason: string, explicit: boolean) {
    const now = Date.now()
    if (this.busy) return
    if (now - this.lastRun < COOLDOWN_MS && !explicit) {
      this.log(`trigger ignored (cooldown): ${reason}`)
      return
    }
    this.busy = true
    this.lastRun = now
    const t0 = Date.now()
    this.log(`TRIGGER ${reason}`)
    try {
      // Announce the camera, but don't wait for speech to finish before capturing.
      void this.session.speaker.speak("Camera on.", {processing: "preferLocal"}).catch(() => {})

      let photoUrl: string | undefined
      try {
        const p = await this.session.camera.takePhoto({size: "medium", compress: "medium", sound: false})
        photoUrl = p.photoUrl
        this.log(`photo ${p.size} B at +${Date.now() - t0} ms`)
      } catch (e) {
        this.log(`photo failed, continuing text-only: ${(e as {message?: string}).message}`)
      }

      const verdict = await this.analyze({
        skill: "scam",
        transcriptWindow: this.window.map((w) => w.text).join(" "),
        photoUrl,
      })
      this.log(`verdict ${verdict.severity} at +${Date.now() - t0} ms`)

      // A silent "safe" result is fine for phrase triggers, but a direct question always gets an answer.
      if (verdict.severity !== "info" || explicit) {
        await this.whisper(verdict.whisper)
        this.log(`whispered at +${Date.now() - t0} ms`)
      }
    } catch (e) {
      this.log(`engine error: ${(e as {message?: string}).message}`)
      await this.whisper("I couldn't check that. Please ask your family before doing anything.")
    } finally {
      this.busy = false
    }
  }

  private async analyze(req: AnalyzeRequest): Promise<Verdict> {
    if (!this.backendUrl) throw new Error("backend URL not set")
    const r = await fetch(`${this.backendUrl}/analyze`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(req),
    })
    if (!r.ok) throw new Error(`analyze ${r.status}`)
    return (await r.json()) as Verdict
  }

  private async whisper(text: string) {
    try {
      await this.session.speaker.speak(text, {processing: "preferLocal", stopOtherAudio: true})
    } catch (e) {
      this.log(`whisper failed: ${(e as {message?: string}).message}`)
    }
  }
}
