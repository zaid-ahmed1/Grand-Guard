/**
 * Engine (spec §5): Trigger → Capture → Check → Whisper → Notify.
 * Owns always-on local STT, the rolling transcript window, triggers and cooldowns.
 * The transcript lives in memory only and is never persisted.
 */
import type {MiniappSession} from "@mentra/miniapp/background"
import type {AnalyzeRequest, CalendarEvent, Verdict} from "../shared/types"
import type {Channels} from "../shared/channels"
import {normalizeTranscript} from "../shared/text"
import {DEFAULT_VOICE, speakOptions, type VoiceConfig} from "../shared/voice"
import {DEFAULT_WAKE, findWake, wakeIssue} from "../shared/wake"

type Session = MiniappSession<Channels>

const WINDOW_MS = 60_000
const COOLDOWN_MS = 10_000
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
  /\b(irs|medicare|arrest(ed)?|warrant|bail|lawyer|jail|police|prize|lottery|sweepstakes|inheritance|western union|zelle|venmo|cash app|paypal|password|passcode|verification code|one time code|otp|pin number|bank account|routing number|virus|hacked|compromised|suspended|locked|refund|overdue|unpaid|penalty|urgent|immediately|act now|right now|grandson|granddaughter|grandchild|in trouble|accident|hospital|keep this secret|between us|don'?t hang up|stay on the line)\b/i,
]
const RANK = {info: 0, warn: 1, danger: 2} as const
const SCAM_COMMAND = /is this a scam|check (this|that) (for a scam|scam)|scam check/i
const FOOD_COMMAND =
  /check (this|that) (food|leftovers?|meal|snack|package|can|box|label)|check (this|that) for (allergens?|expir)|can i eat (this|that)|(is|are) (this|that|these) (food )?(safe|ok|okay|good) to eat|is this (food )?expired|what'?s in this (food|package|box)/

const CANCEL = /\b(cancel|never ?mind|stop|forget it)\b/
const REPEAT = /\b(say that again|repeat that|what did (he|she|they|you) say|come again|say again)\b/
/** Wake-addressed questions that are about something the wearer is looking at. */
const LOOK = /\b(this|that|these|those|read|look|says?|label|letter|bill|menu|sign|screen|remote|device|button)\b/
const FOODISH = /\b(food|expired|allerg\w*|safe to eat|can i eat)\b/
const AWAIT_MS = 8_000
/** Calendar and clock questions work with no wake word: the person who needs them most may have forgotten it. */
const CALENDAR_COMMAND =
  /what (am i|should i be) (supposed to be )?doing|where (am i|should i be) supposed to be|where am i supposed to be|what'?s (next|on my (schedule|calendar|agenda))|what do i have (today|next|going on|coming up)|what'?s (my )?(schedule|plan)( for today)?|what am i doing (right )?now|what'?s happening (now|today)|what'?s on today/
const CLOCK_COMMAND = /what time is it|what'?s the time|what day is it|what'?s (the )?(date|day) (today|is it)|what is today/
/** Looser schedule wording. No wake word needed, but these go through the router, which ignores non-requests. */
const CALENDAR_LOOSE =
  /\bwhat do i have\b|\bdo i have (anything|any|a|an)\b|\bam i (free|busy)\b|\bwhat'?s (on|planned|scheduled|happening|going on)\b|\bappointments?\b|\bmy (schedule|calendar)\b|\bremind me\b|\b(add|put) .{0,40}(to|on) my (calendar|schedule)\b/
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
    if (savedWake) this.wake = savedWake
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
  }

  private ingest(text: string, forced: boolean) {
    const now = Date.now()
    if (!forced && (this.speaking || now < this.mutedUntil)) return

    // Waiting for "yes" or "no" to a read-back? Answer it first. Anything else cancels the pending add.
    if (this.pendingAdd) {
      const reply = normalizeTranscript(text)
      const pending = this.pendingAdd
      this.pendingAdd = null
      if (now < pending.until) {
        if (YES.test(reply)) return void this.confirmAdd(pending.event)
        if (NO.test(reply)) return void this.whisper("Okay. It was not added.")
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
          this.log("wake word heard, listening")
          void this.whisper("Listening.")
          return
        }
      }
    }
    if (request !== null) {
      void this.ask(request)
      return
    }

    // Calendar and clock questions: direct phrases, answered without any wake word.
    const direct = normalizeTranscript(text)
    if (CALENDAR_COMMAND.test(direct)) return void this.runCalendar()
    if (CLOCK_COMMAND.test(direct)) return void this.runClock()
    if (CALENDAR_LOOSE.test(direct)) return void this.routeRequest(text, false)

    this.window.push({at: now, text})
    this.window = this.window.filter((w) => now - w.at <= WINDOW_MS)

    // STT spells out acronyms ("i r s"), so match against a normalised copy.
    const norm = normalizeTranscript(text)
    if (FOOD_COMMAND.test(norm)) {
      void this.runFood()
      return
    }
    const command = SCAM_COMMAND.test(norm)
    const trigger = SCAM_TRIGGERS.find((re) => re.test(norm))
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

  /** General help (read this, explain this, how do I use this). Takes a photo only when the request is about something visible. */
  private async runAsk(question: string, look: boolean) {
    if (this.busy) return
    this.busy = true
    const t0 = Date.now()
    try {
      let photoUrl: string | undefined
      if (look) {
        const announce = this.whisper("Taking a photo now.")
        try {
          photoUrl = (await this.session.camera.takePhoto({size: "high", compress: "none", sound: false})).photoUrl
          this.log(`ask photo ready at +${Date.now() - t0} ms`)
        } catch (e) {
          this.log(`ask photo failed: ${(e as {message?: string}).message}`)
        }
        await announce
        if (!photoUrl) return void (await this.whisper("Unable to take a photo. Please hold it steady and try again."))
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
    try {
      // Announce the camera and capture at the same moment; speech keeps playing while the photo uploads.
      const announce = this.whisper("Checking this food. Taking a photo now.")
      let photoUrl: string | undefined
      try {
        photoUrl = (await this.session.camera.takePhoto({size: "high", compress: "none", sound: false})).photoUrl
        this.log(`food photo ready at +${Date.now() - t0} ms`)
      } catch (e) {
        this.log(`food photo failed: ${(e as {message?: string}).message}`)
      }
      await announce
      if (!photoUrl) {
        await this.whisper("Unable to take a photo. Please hold the package steady and try again.")
        return
      }
      const v = await this.analyze({skill: "food", transcriptWindow: "", photoUrl})
      this.log(`food verdict ${v.severity} via ${v.source} at +${Date.now() - t0} ms`)
      this.log(`whisper: "${v.whisper}"`)
      await this.whisper(v.whisper)
    } catch (e) {
      this.log(`food error: ${(e as {message?: string}).message}`)
      await this.whisper("Unable to check this food. Please read the label yourself for allergens and the date.")
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
