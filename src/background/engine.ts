/**
 * Engine (spec §5): Trigger → Capture → Check → Whisper → Notify.
 * Owns always-on local STT, the rolling transcript window, triggers and cooldowns.
 * The transcript lives in memory only and is never persisted.
 */
import type {MiniappSession} from "@mentra/miniapp/background"
import type {AnalyzeRequest, Verdict} from "../shared/types"
import type {Channels, Processing} from "../shared/channels"

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
const RANK = {info: 0, warn: 1, danger: 2} as const
const SCAM_COMMAND = /is this a scam|check (this|that) (for a scam|scam)|scam check/i

export class Engine {
  private window: {at: number; text: string}[] = []
  private busy = false
  private lastRun = 0
  private backendUrl = DEFAULT_BACKEND
  private voice: {processing: Processing; speed: number} = {processing: "preferLocal", speed: 0.85}

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
    const savedVoice = await this.session.storage.get("voice")
    if (savedVoice) this.voice = JSON.parse(savedVoice)
    this.session.ui.on("engine:setVoice", async (v) => {
      this.voice = v
      await this.session.storage.set("voice", JSON.stringify(v))
      this.log(`whisper voice: ${v.processing}, speed ${v.speed}`)
    })
    this.session.ui.on("engine:simulate", ({text}) => this.ingest(text, true))
    this.session.ui.onOpen(() => {
      this.session.ui.send("engine:backend", {url: this.backendUrl})
      this.session.ui.send("engine:voice", this.voice)
    })

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
      const transcriptWindow = this.window.map((w) => w.text).join(" ")

      // Step 1: transcript-only verdict. No camera yet, so a pure phone scam never takes a photo.
      const first = await this.analyze({skill: "scam", transcriptWindow})
      this.log(`text verdict ${first.severity} via ${first.source}, needsPhoto=${first.needsPhoto} at +${Date.now() - t0} ms`)

      // A silent "safe" result is fine for phrase triggers, but a direct question always gets an answer.
      const speak = first.severity !== "info" || explicit
      // Looking is only worth it for something visible, or when the wearer asked about what they see.
      const wantPhoto = (first.needsPhoto === true && first.severity !== "info") || explicit

      if (speak) {
        // The camera announces itself in the same breath, before any capture.
        const line = wantPhoto ? `${first.whisper} I'm taking a photo now.` : first.whisper
        this.log(`whisper: "${line}"`)
        await this.whisper(line)
        this.log(`first whisper done at +${Date.now() - t0} ms`)
      }

      // Step 2: optional photo, used to enrich the caregiver event; speak again only if it escalates.
      if (wantPhoto) {
        let photoUrl: string | undefined
        try {
          photoUrl = (await this.session.camera.takePhoto({size: "medium", compress: "medium", sound: false})).photoUrl
          this.log(`photo ready at +${Date.now() - t0} ms`)
        } catch (e) {
          this.log(`photo failed, text-only: ${(e as {message?: string}).message}`)
        }
        if (photoUrl) {
          const second = await this.analyze({skill: "scam", transcriptWindow, photoUrl, refines: first.eventId})
          this.log(`vision verdict ${second.severity} via ${second.source} at +${Date.now() - t0} ms`)
          if (RANK[second.severity] > RANK[first.severity]) await this.whisper(second.whisper)
        }
      } else {
        this.log("no photo needed (audio-only scam)")
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
      await this.session.speaker.speak(text, {
        processing: this.voice.processing,
        stopOtherAudio: true,
        voice_settings: {speed: this.voice.speed},
      })
    } catch (e) {
      this.log(`whisper failed: ${(e as {message?: string}).message}`)
    }
  }
}
