/**
 * Engine (spec §5): Trigger → Capture → Check → Whisper → Notify.
 * Owns always-on local STT, the rolling transcript window, triggers and cooldowns.
 * The transcript lives in memory only and is never persisted.
 */
import type {MiniappSession} from "@mentra/miniapp/background"
import type {AnalyzeRequest, CalendarEvent, Verdict} from "../shared/types"
import type {Channels} from "../shared/channels"
import {FALL_PHRASE, FallGuard} from "./fall"
import {normalizeTranscript} from "../shared/text"
import {DEFAULT_VOICE, speakOptions, type VoiceConfig} from "../shared/voice"
import {DEFAULT_WAKE, findWake, wakeIssue} from "../shared/wake"

type Session = MiniappSession<Channels>

const WINDOW_MS = 60_000
const COOLDOWN_MS = 10_000
/** One photo size for warm-up and capture (a mismatch makes the camera reconfigure, which is slow). */
const PHOTO_SIZE = "high" as const
const WARM_MS = 30_000
/** 1 = leave auto-exposure alone. Raise toward 2 if photos are still too bright, lower to 1 if they come out dark. */
const EXPOSURE_DIVISOR = 1.6
// Inlined at build time by `define`; the bare JS engine has no `process` global, so guard it.
const DEFAULT_BACKEND: string = typeof process !== "undefined" ? (process.env.MENTRA_PUBLIC_BACKEND_URL ?? "") : ""

/** Cheap local triggers. The backend LLM makes the real call. */
const SCAM_TRIGGERS: RegExp[] = [
  /gift ?cards?/i,
  /wire (the )?(money|transfer)|wire transfer/i,
  /bitcoin|crypto(currency)? atm|crypto/i,
  /don'?t tell (anyone|anybody|your)/i,
  /remote access|anydesk|teamviewer/i,
  // Requests for sensitive details. Claude decides if it is actually a scam.
  /social security (number|digits)|\bssn\b|last (four|4) of (your|my) social/i,
  /credit card|debit card|card number|\bcvv\b|security code/i,
  /your (computer|device) (has|is|was).{0,20}(virus|infected|hacked)/i,
  /\b(irs|social security|medicare)\b.{0,40}(owe|arrest|suspend|call|problem|payment|refund|benefit|account|penalty|warrant|verify)/i,
  /\bthis is (the )?(irs|internal revenue|medicare|social security)/i,
  // Demands for money. Claude judges context (a birthday gift is fine).
  /\b(send|wire|transfer|mail|give|pay)\b.{0,15}\b(money|cash)\b/i,
  // Broad net: any single scam-flavoured word. This only decides WHEN to ask Claude; Claude decides if it is a scam.
  /\b(irs|medicare|arrest(ed)?|warrant|bail|lawyer|jail|police|prize|lottery|sweepstakes|inheritance|western union|zelle|venmo|cash app|paypal|password|passcode|verification code|one time code|otp|pin number|bank account|routing number|virus|hacked|compromised|suspended|locked|refund|overdue|unpaid|penalty|urgent|act now|grandson|granddaughter|grandchild|in trouble|accident|hospital|keep this secret|between us|don'?t hang up|stay on the line)\b/i,
]
const RANK = {info: 0, warn: 1, danger: 2} as const
const SCAM_COMMAND = /is this a scam|check (this|that) (for a scam|scam)|scam check/i
const FOOD_COMMAND =
  /check (this|that) (food|leftovers?|meal|snack|package|can|box|label)|check (this|that) for (allergens?|expir)|can i (eat|drink) (this|that)|(is|are) (this|that|these) (food |drink )?(safe|ok|okay|good) to (eat|drink)|check (this|that) (drink|beverage|bottle|juice|carton|cup)|is this (food )?expired|what'?s in this (food|package|box)/

const CANCEL = /\b(cancel|never ?mind|stop|forget it)\b/
const REPEAT = /\b(say that again|repeat that|what did (he|she|they|you) say|come again|say again)\b/
/** Wake-addressed questions that are about something the wearer is looking at. */
const LOOK = /\b(this|that|these|those|read|look|says?|label|letter|bill|menu|sign|screen|remote|device|button)\b/
const FOODISH = /\b(food|drink|beverage|expired|allerg\w*|safe to (eat|drink)|can i (eat|drink))\b/
const AWAIT_MS = 8_000
/** Calendar and clock questions work with no wake word: the person who needs them most may have forgotten it. */
const CALENDAR_COMMAND =
  /(am i|should i be) (supposed to be )?doing|supposed to be doing|where (am i|should i be) supposed to be|where am i supposed to be|what'?s (next|on my (schedule|calendar|agenda))|what do i have (today|next|going on|coming up)|what'?s (my )?(schedule|plan)( for today)?|what am i doing (right )?now|what'?s happening (now|today)|what'?s on today/
const CLOCK_COMMAND = /what time is it|what'?s the time|what day is it|what'?s (the )?(date|day) (today|is it)|what is today/
/** Looser schedule wording. No wake word needed, but these go through the router, which ignores non-requests. */
const CALENDAR_LOOSE =
  /\bwhat do i have\b|\bdo i have (anything|any|a|an)\b|\bam i (free|busy)\b|\bwhat'?s (on|planned|scheduled|happening|going on)\b|\bappointments?\b|\bmy (schedule|calendar)\b|\bremind me\b|\b(add|put) .{0,40}(to|on) my (calendar|schedule)\b/
/**
 * Food wording that needs no wake word. Deliberately specific (a question about "this", or date/allergen words) so
 * ordinary talk about eating never takes a photo. The router still decides, and ignores non-requests.
 */
const FOOD_LOOSE =
  /\b(still good|gone bad|gone off|expired|expiry|expiration|use by|best before|allergens?|ingredients?)\b|\b(can|should|could) i (eat|drink|have) (this|that|it)\b|\b(is|are) (this|that|it|these) (safe|ok|okay|fine|good) (to|for)\b|\bdoes (this|it) (have|contain)\b/
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|correct|please|do it|go ahead|that'?s right|right)\b/
const NO = /^(no|nope|nah|cancel|never ?mind|don'?t|stop|wrong)\b/
const CONFIRM_MS = 12_000
const REMIND_EVERY_MS = 60_000
/** Hold a reminder back while anyone has spoken this recently. */
const QUIET_BEFORE_REMINDER_MS = 2_000
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

export class Engine {
  private window: {at: number; text: string}[] = []
  private busy = false
  private fall = new FallGuard({
    say: (t) => this.whisper(t),
    alert: (r) => this.alertFall(r),
    log: (m) => this.log(m),
  })
  /** Camera warm-up state. A cold camera was the cause of 25 s photo timeouts, so it is warmed as soon as the wearer speaks to us. */
  private warming: Promise<void> | null = null
  private warmUntil = 0
  private warmOffUntil = 0
  private capturing = false
  private wake = DEFAULT_WAKE
  private awaitUntil = 0
  /** Our own speech can be picked up by the mic; ignore transcripts while speaking and just after. */
  private speaking = false
  private mutedUntil = 0
  private lastHeardAt = 0
  /** A calendar event the wearer asked to add, waiting for their "yes". Nothing is saved without it. */
  private pendingAdd: {event: Partial<CalendarEvent>; until: number} | null = null
  private lastRun = 0
  private backendUrl = DEFAULT_BACKEND
  private voice: VoiceConfig = DEFAULT_VOICE

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
    if (savedVoice) this.voice = {...DEFAULT_VOICE, ...JSON.parse(savedVoice)}
    this.session.ui.on("engine:setVoice", async (v) => {
      this.voice = v
      await this.session.storage.set("voice", JSON.stringify(v))
      this.log(`whisper voice: ${JSON.stringify(v)}`)
    })
    const savedWake = await this.session.storage.get("wake")
    // "grand guard" was the old default (before the rename to Ally), so do not keep it as a chosen word.
    if (savedWake && savedWake !== "grand guard") this.wake = savedWake
    this.log(`wake word: "${this.wake}"`)
    this.session.ui.on("engine:setWake", async ({phrase}) => {
      const p = phrase.trim()
      const issue = wakeIssue(p)
      if (issue) {
        this.log(`wake word rejected: ${issue}`)
        return
      }
      this.wake = p
      await this.session.storage.set("wake", p)
      this.log(`wake word set to "${p}"`)
    })
    this.session.ui.on("engine:simulate", ({text}) => this.ingest(text, true))
    this.session.ui.onOpen(() => {
      this.session.ui.send("engine:wake", {phrase: this.wake})
      this.session.ui.send("engine:backend", {url: this.backendUrl})
      this.session.ui.send("engine:voice", this.voice)
    })

    // Local-only STT: audio never leaves the phone, only text goes to the backend.
    this.session.transcription.on((d) => {
      this.lastHeardAt = Date.now()
      this.session.ui.send("p0:transcript", {text: d.text, isFinal: d.isFinal, source: d.source, latencyMs: 0})
      if (d.isFinal) this.ingest(d.text, false)
    }, {processing: "localOnly"})
    this.log("engine listening (localOnly STT)")
    setInterval(() => void this.checkReminders(), REMIND_EVERY_MS)

    // Fall sensor: only glasses that stream an accelerometer will deliver readings. The voice check-in works either way.
    try {
      const caps = this.session.capabilities
      const imuKeys = Object.keys(caps ?? {}).filter((k) => /imu|accel|motion|gyro/i.test(k))
      this.log(`glasses capabilities: ${Object.keys(caps ?? {}).join(", ") || "none reported"}${imuKeys.length ? ` (motion: ${imuKeys.join(", ")})` : ""}`)
      this.session.imu.onAccel((d) => this.onAccel(d.x, d.y, d.z, d.timestamp, false))
      this.session.imu.onHeadPosition((h) => this.session.ui.send("p0:imu", {status: "head position event", head: h.position}))
      this.session.ui.on("engine:simFall", () => this.simulateFall())
      setTimeout(() => {
        if (!this.fall.streaming) {
          this.log("no accelerometer data from these glasses; fall detection is voice-only (say \"I've fallen\")")
          this.session.ui.send("p0:imu", {status: "No accelerometer data received. These glasses probably do not stream it, so fall response is voice-only."})
        }
      }, 15_000)
    } catch (e) {
      this.log(`accelerometer unavailable: ${(e as {message?: string}).message}`)
    }
  }

  private lastAccelSent = 0
  private peakSinceSent = 0

  /** One accelerometer reading, real or simulated: feed the fall detector and show it (about 10 per second) in the UI. */
  private onAccel(x: number, y: number, z: number, at: number, simulated: boolean) {
    this.fall.feed(x, y, z, at)
    const m = Math.sqrt(x * x + y * y + z * z)
    this.peakSinceSent = Math.max(this.peakSinceSent, m)
    const now = Date.now()
    if (now - this.lastAccelSent < 90) return
    this.lastAccelSent = now
    this.session.ui.send("p0:accel", {x, y, z, m, peak: this.peakSinceSent, at: now, simulated})
    this.peakSinceSent = 0
  }

  /** Test the detector without a real fall: rest, free-fall, impact, stillness. This really starts the "Are you okay?" check-in. */
  private simulateFall() {
    this.log("SIMULATED fall (not a real sensor reading)")
    const t0 = Date.now()
    const timer = setInterval(() => {
      const t = Date.now() - t0
      const n = () => (Math.random() - 0.5) * 0.04
      let z = 1
      if (t >= 800 && t < 1050) z = 0.15
      else if (t >= 1050 && t < 1150) z = 3.4
      this.onAccel(n(), n(), z + n(), Date.now(), true)
      if (t > 4500) clearInterval(timer)
    }, 40)
  }

  private ingest(text: string, forced: boolean) {
    const now = Date.now()
    if (!forced && (this.speaking || now < this.mutedUntil)) return

    // A fall check-in is open: what the wearer says now is the answer to "Are you okay?".
    if (this.fall.active) {
      this.chat("you", text)
      this.fall.hear(normalizeTranscript(text))
      return
    }

    // Waiting for "yes" or "no" to a read-back? Answer it first. Anything else cancels the pending add.
    if (this.pendingAdd) {
      const reply = normalizeTranscript(text)
      const pending = this.pendingAdd
      this.pendingAdd = null
      if (now < pending.until) {
        if (YES.test(reply)) return void (this.chat("you", text), this.confirmAdd(pending.event))
        if (NO.test(reply)) return void (this.chat("you", text), this.whisper("Okay. It was not added."))
      }
    }

    // Addressed to the assistant: either "<wake> <request>" or the request right after a bare "<wake>".
    // These utterances are commands, so they never enter the scam-detection window.
    let request: string | null = null
    if (this.awaitUntil > now) {
      this.awaitUntil = 0
      request = text
    } else {
      const w = findWake(text, this.wake)
      if (w) {
        if (w.rest) request = w.rest
        else {
          this.awaitUntil = now + AWAIT_MS
          this.warmCamera()
          this.log("wake word heard, listening")
          void this.whisper("Listening.")
          return
        }
      }
    }
    if (request !== null) {
      this.warmCamera()
      this.chat("you", request)
      void this.ask(request)
      return
    }

    // Calendar and clock questions: direct phrases, answered without any wake word.
    const direct = normalizeTranscript(text)
    if (FALL_PHRASE.test(direct)) return void (this.chat("you", text), this.fall.start("said"))
    if (CALENDAR_COMMAND.test(direct)) return void (this.chat("you", text), this.runCalendar())
    if (CLOCK_COMMAND.test(direct)) return void (this.chat("you", text), this.runClock())
    if (CALENDAR_LOOSE.test(direct) || FOOD_LOOSE.test(direct)) return void (this.chat("you", text), this.routeRequest(text, false))

    this.window.push({at: now, text})
    this.window = this.window.filter((w) => now - w.at <= WINDOW_MS)

    // STT spells out acronyms ("i r s"), so match against a normalised copy.
    const norm = normalizeTranscript(text)
    if (FOOD_COMMAND.test(norm)) {
      this.warmCamera()
      this.chat("you", text)
      void this.runFood()
      return
    }
    const command = SCAM_COMMAND.test(norm)
    const trigger = SCAM_TRIGGERS.find((re) => re.test(norm))
    if (!command && !trigger && !forced) return
    this.chat("you", text)
    void this.run(command ? "voice command" : `phrase ${trigger ?? "simulated"}`, command || forced, text)
  }

  private async run(reason: string, explicit: boolean, latest?: string) {
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
      const earlier = this.window.map((w) => w.text).join(" ")
      // The window can hold minutes of unrelated speech. Point at the statement that triggered this check.
      const transcriptWindow = latest ? `${earlier}

Most recent statement (judge this one): "${latest}"` : earlier

      // Step 1: transcript-only verdict. No camera yet, so a pure phone scam never takes a photo.
      const first = await this.analyze({skill: "scam", transcriptWindow})
      this.log(`text verdict ${first.severity} via ${first.source}, needsPhoto=${first.needsPhoto} at +${Date.now() - t0} ms`)

      // A silent "safe" result is fine for phrase triggers, but a direct question always gets an answer.
      const speak = first.severity !== "info" || explicit
      // A safe result must not block the next trigger, so a real scam right after a harmless line still gets checked.
      if (!speak) this.lastRun = 0
      // Looking is only worth it for something visible, or when the wearer asked about what they see.
      const wantPhoto = (first.needsPhoto === true && first.severity !== "info") || explicit

      if (speak) {
        // The camera announces itself in the same breath, before any capture.
        const line = wantPhoto ? `${first.whisper} Taking a photo now.` : first.whisper
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
        this.log(speak ? "no photo needed (audio-only scam)" : "judged safe, staying silent")
      }
    } catch (e) {
      this.log(`engine error: ${(e as {message?: string}).message}`)
      await this.whisper("I was unable to verify this. Please check with a family member before acting.")
    } finally {
      this.busy = false
    }
  }

  /** Route a wake-addressed request to the right skill. The wearer speaks naturally; nothing to memorise. */
  private async ask(text: string) {
    const norm = normalizeTranscript(text)
    this.log(`ASK "${norm}"`)
    if (CANCEL.test(norm)) return this.log("cancelled")
    if (FALL_PHRASE.test(norm)) return this.fall.start("said")
    if (CALENDAR_COMMAND.test(norm)) return this.runCalendar()
    if (CLOCK_COMMAND.test(norm)) return this.runClock()
    if (FOOD_COMMAND.test(norm) || FOODISH.test(norm)) return this.runFood()
    if (SCAM_COMMAND.test(norm) || /\bscam/.test(norm)) return this.run("voice command", true)
    if (REPEAT.test(norm)) return this.repeat()
    // Unclear phrasing: let the router (one fast Claude call) pick a tool.
    return this.routeRequest(text, true)
  }

  /**
   * Ask Claude Haiku which tool fits the request, then run it. Clear phrases never get here (they match locally, no lag).
   * `addressed` is true when the wearer used their wake word; unaddressed schedule talk is dropped silently if it is not a request.
   * If the router is unreachable, an addressed request falls back to the general Ask skill.
   */
  private async routeRequest(text: string, addressed: boolean) {
    if (this.busy) return
    this.busy = true
    const t0 = Date.now()
    let v: Verdict | null = null
    try {
      v = await this.analyze({skill: "route", transcriptWindow: text, localNow: this.localNow()})
    } catch (e) {
      this.log(`router unavailable: ${(e as {message?: string}).message}`)
    } finally {
      this.busy = false
    }
    if (!v) return addressed ? this.runAsk(text, LOOK.test(normalizeTranscript(text))) : undefined
    this.log(`route -> ${v.action} via ${v.source} at +${Date.now() - t0} ms`)
    switch (v.action) {
      case "speak":
        this.log(`whisper: "${v.whisper}"`)
        return this.whisper(v.whisper)
      case "clock": return this.runClock()
      case "food": return this.runFood()
      case "scam": return this.run("voice command", true)
      case "repeat": return this.repeat()
      case "ask": return this.runAsk(v.question || text, v.needsPhoto ?? LOOK.test(normalizeTranscript(text)))
      case "confirm_add":
        if (!v.event) return
        this.pendingAdd = {event: v.event, until: Date.now() + CONFIRM_MS}
        this.log(`confirm add: "${v.whisper}"`)
        return this.whisper(v.whisper)
      default:
        return addressed ? this.runAsk(text, LOOK.test(normalizeTranscript(text))) : undefined
    }
  }

  /** The wearer said yes: save the event, marked as set by them so the caregiver sees who added it. */
  private async confirmAdd(event: Partial<CalendarEvent>) {
    try {
      const r = await fetch(`${this.backendUrl}/calendar?by=wearer`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(event)})
      if (!r.ok) throw new Error(`calendar ${r.status}`)
      this.log(`added to calendar: ${JSON.stringify(event)}`)
      await this.whisper("Added to your schedule.")
    } catch (e) {
      this.log(`add failed: ${(e as {message?: string}).message}`)
      await this.whisper("Unable to add that. Please ask a family member.")
    }
  }

  /** The phone's local date and time, "YYYY-MM-DDTHH:MM". The server does no time-zone math. */
  private localNow(d = new Date()) {
    const p = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  }

  /** "What am I supposed to be doing?" Answered by plain code on the server from the caregiver's schedule. */
  private async runCalendar() {
    if (this.busy) return
    this.busy = true
    try {
      const v = await this.analyze({skill: "calendar", transcriptWindow: "", localNow: this.localNow(), query: "now"})
      this.log(`calendar: "${v.whisper}"`)
      await this.whisper(v.whisper)
    } catch (e) {
      this.log(`calendar error: ${(e as {message?: string}).message}`)
      await this.whisper("Unable to read the calendar right now. Please ask a family member.")
    } finally {
      this.busy = false
    }
  }

  /** Time and date come from the phone's clock, so this works with no network. */
  private async runClock() {
    if (this.busy) return
    const d = new Date()
    const h = d.getHours()
    const m = d.getMinutes()
    const time = `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`
    const line = `It is ${time} on ${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}.`
    this.log(`clock: "${line}"`)
    await this.whisper(line)
  }

  /** Ambient: a reminder shortly before an event. Skipped while anyone is talking or the glasses are busy. */
  private async checkReminders() {
    const now = Date.now()
    if (!this.backendUrl || this.busy || this.speaking || this.awaitUntil > now) return
    if (now - this.lastHeardAt < QUIET_BEFORE_REMINDER_MS) return
    try {
      const v = await this.analyze({skill: "calendar", transcriptWindow: "", localNow: this.localNow(), query: "remind"})
      if (!v.whisper) return
      this.log(`reminder: "${v.whisper}"`)
      await this.whisper(v.whisper)
    } catch {
      // Quiet by design: a failed background poll must never speak.
    }
  }

  /** "Say that again": replay the last few seconds from the local transcript, slowly. Nothing leaves the device. */
  private async repeat() {
    const now = Date.now()
    const recent = this.window.filter((w) => now - w.at <= 20_000).slice(-2).map((w) => w.text)
    if (!recent.length) return this.whisper("Nothing was heard just now.")
    this.log("repeating recent speech")
    await this.whisper(recent.join(" "))
  }

  /**
   * Take a photo of a label or page at the size known to upload reliably (a "high" uncompressed photo timed out).
   * The glasses allow one photo job at a time, so this NEVER starts a second photo while one may be in flight:
   * on "busy / another job in progress" it waits and retries the same request; on any other failure it stops.
   */
  /**
   * Wake the glasses camera before it is needed, so the photo itself is quick. Called when the wearer addresses us
   * (wake word) or says a food command, never otherwise. The camera is only held ready for 30 s, and warm-up must
   * use the same size as the capture or it is wasted.
   */
  private warmCamera() {
    if (this.capturing || this.warming || Date.now() < this.warmOffUntil || Date.now() < this.warmUntil - 8000) return
    this.warmUntil = Date.now() + WARM_MS
    const t = Date.now()
    this.warming = this.session.camera
      .warmUp({size: PHOTO_SIZE, durationMs: WARM_MS})
      .then(() => this.log(`camera warm in ${Date.now() - t} ms`))
      .catch((e) => {
        this.warmUntil = 0
        // A warm-up that hangs can collide with the real photo, so one failure turns it off for a while.
        this.warmOffUntil = Date.now() + 5 * 60_000
        this.log(`camera warm-up failed, off for 5 minutes: ${(e as {message?: string}).message}`)
      })
      .finally(() => {
        this.warming = null
      })
  }

  private async capturePhoto(
    t0: number,
    size: "medium" | "high" | "max" = PHOTO_SIZE,
    direct = false,
  ): Promise<{url?: string; why?: "busy" | "failed"}> {
    let why: "busy" | "failed" = "failed"
    // Let a warm-up in progress finish first (at most 6 s), so the two never collide on the camera.
    if (this.warming) await Promise.race([this.warming, new Promise((res) => setTimeout(res, 4000))])
    this.capturing = true
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const r = await this.session.camera.takePhoto({
            size,
            compress: "medium",
            sound: false,
            timeoutMs: 30_000,
          // Auto-exposure overshoots on bright scenes and white packaging, which washes out label text. Pull the metered
          // exposure down a little. (SDK: "after AE convergence, divide the metered exposure by this factor".)
          aeExposureDivisor: EXPOSURE_DIVISOR,
            // "auto" lets the glasses pick Wi-Fi and fall back to Bluetooth themselves. Forcing direct timed out on a cold
          // start, and abandoning a timed-out job left the next photo blocked ("another photo job is in progress").
            transferMethod: direct ? "direct" : "auto",
          })
          this.log(`photo ready (${size}/${direct ? "direct" : "auto"}) at +${Date.now() - t0} ms`)
          this.warmUntil = Date.now() + WARM_MS
          return {url: r.photoUrl}
        } catch (e) {
          const msg = (e as {message?: string}).message ?? String(e)
          this.log(`photo failed (try ${attempt}): ${msg}`)
          if (!/busy|in progress/i.test(msg)) return {why: "failed"}
          why = "busy"
          await new Promise((res) => setTimeout(res, 3000))
        }
      }
    return {why}
    } finally {
      this.capturing = false
    }
  }

  private photoFailLine(why?: "busy" | "failed") {
    return why === "busy"
      ? "The camera is still finishing the last photo. Please try again in a few seconds."
      : "Unable to take a photo. Please try again."
  }

  /** General help (read this, explain this, how do I use this). Takes a photo only when the request is about something visible. */
  private async runAsk(question: string, look: boolean) {
    if (this.busy) return
    this.busy = true
    const t0 = Date.now()
    try {
      let photoUrl: string | undefined
      if (look) {
        this.warmCamera()
        const announce = this.whisper("Taking a photo now.")
        const photo = await this.capturePhoto(t0)
        await announce
        if (!photo.url) return void (await this.whisper(this.photoFailLine(photo.why)))
        photoUrl = photo.url
      }
      const v = await this.analyze({skill: "ask", transcriptWindow: question, photoUrl})
      this.log(`ask verdict via ${v.source} at +${Date.now() - t0} ms`)
      this.log(`whisper: "${v.whisper}"`)
      await this.whisper(v.whisper)
    } catch (e) {
      this.log(`ask error: ${(e as {message?: string}).message}`)
      await this.whisper("Unable to answer that right now. Please try again.")
    } finally {
      this.busy = false
    }
  }

  /** Food Check: a spoken command only. The camera is never used without the wearer asking, and it announces itself. */
  private async runFood() {
    if (this.busy) return
    this.busy = true
    const t0 = Date.now()
    this.log("TRIGGER food check")
    this.warmCamera() // also covers food requests that did not use the wake word
    try {
      // Pass 1 uses the size that uploads reliably. If nothing is readable, ask the wearer to move closer and
      // retake once at a sharper size. The camera announces itself both times.
      let v: Verdict | undefined
      for (let pass = 1; pass <= 2; pass++) {
        const announce = this.whisper(pass === 1 ? "Checking this food. Taking a photo now." : "Taking a photo now.")
        // Medium over direct Wi-Fi first; the retake (label unreadable) is high. If direct Wi-Fi fails, one more
        // try over the automatic route at medium.
        let photo = await this.capturePhoto(t0)
        if (!photo.url && photo.why === "failed") {
          this.log("photo failed, trying once more")
          await new Promise((res) => setTimeout(res, 4000))
          photo = await this.capturePhoto(t0)
        }
        await announce
        if (!photo.url) {
          if (v) break // the sharper retry failed: fall back to the first verdict
          await this.whisper(this.photoFailLine(photo.why))
          return
        }
        v = await this.analyze({skill: "food", transcriptWindow: "", photoUrl: photo.url})
        this.log(`food verdict ${v.severity} via ${v.source}${v.unreadable ? " (unreadable)" : ""} at +${Date.now() - t0} ms`)
        if (!v.unreadable || pass === 2) break
        await this.whisper("The label is hard to read. Hold it closer. Taking another photo in three seconds.")
        await new Promise((res) => setTimeout(res, 3000))
      }
      this.log(`whisper: "${v!.whisper}"`)
      await this.whisper(v!.whisper)
    } catch (e) {
      this.log(`food error: ${(e as {message?: string}).message}`)
      await this.whisper("Unable to check this food. Please read the label yourself for allergens and the date.")
    } finally {
      this.busy = false
    }
  }

  /** Tell the caregiver about a possible fall. True only if the backend took it. */
  private async alertFall(reason: string): Promise<boolean> {
    try {
      await this.analyze({skill: "fall", transcriptWindow: reason})
      return true
    } catch (e) {
      this.log(`fall alert failed: ${(e as {message?: string}).message}`)
      return false
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

  /** Demo chat: what the wearer said (only the words it acted on) and what it whispered. Fire and forget. */
  private chat(role: "you" | "guard", text: string) {
    if (!this.backendUrl || !text.trim()) return
    void fetch(`${this.backendUrl}/chat`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({role, text}),
    }).catch(() => {})
  }

  private async whisper(text: string) {
    this.chat("guard", text)
    this.speaking = true
    try {
      await this.session.speaker.speak(text, {
        ...speakOptions(this.voice),
        stopOtherAudio: true,
      })
    } catch (e) {
      this.log(`whisper failed: ${(e as {message?: string}).message}`)
    } finally {
      this.speaking = false
      this.mutedUntil = Date.now() + 1200
    }
  }
}
