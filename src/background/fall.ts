/**
 * Fall response. Two ways in, one way out.
 *
 * In: the wearer says they fell (works on any glasses), or the glasses accelerometer sees free-fall, an impact and then
 * stillness (only on glasses that stream it; Mentra Live may not).
 * Out: Grand Guard asks "Are you okay?". "I'm okay" ends it. "Help", "no" or silence for 15 s tells the caregiver.
 * Nothing is sent without that check-in, and the wearer can always dismiss a false alarm by speaking.
 */

/** "I fell", "I've fallen", "I can't get up". Excludes figures of speech like "fell asleep". */
export const FALL_PHRASE =
  /\bi (have |just )*(fell|fallen)\b(?! (asleep|in love|for|behind|out of|off the wagon))|\bi'?ve (just )?(fallen|fell)\b|\bi (can'?t|cannot|couldn'?t) (get|stand) (back )?up\b|\bi (slipped|tripped) and (fell|fallen)\b|\bi (took|had) a fall\b/

const HELP = /\b(help|hurt|pain|ambulance|not (ok|okay|fine|alright)|can'?t (get up|move|stand))\b|^(no|nope|nah)\b/
const OK = /\b(i'?m|i am|im) (ok|okay|fine|alright|all right|good|not hurt)\b|\bfalse alarm\b|\bno need\b|^(yes|yeah|yep|ok|okay|fine)\b/

const ASK_MS = 15_000
/** After one check-in, wait this long before another can start. */
const COOLDOWN_MS = 60_000

/** Accelerometer thresholds, in g. Resting is about 1 g. */
const FREE_FALL_G = 0.5
const IMPACT_G = 2.5
const IMPACT_WINDOW_MS = 1_200
const STILL_BAND_G = 0.25
const STILL_MS = 2_000

export type FallHooks = {
  /** Speak a line and resolve when it has finished. */
  say: (text: string) => Promise<void>
  /** Tell the caregiver. Resolves true only if the backend accepted it. */
  alert: (reason: string) => Promise<boolean>
  log: (msg: string) => void
}

export class FallGuard {
  private asking = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastStart = 0

  // Accelerometer state.
  private freeFallAt = 0
  private impactAt = 0
  private samples: {at: number; m: number}[] = []
  private firstReadingLogged = false

  constructor(private h: FallHooks) {}

  get active() {
    return this.asking
  }

  /**
   * Begin the check-in. Ignored while one is already open. The wearer saying they fell always starts one; only the
   * sensor is held back for a minute after a check-in (so one tumble cannot start it repeatedly).
   */
  async start(reason: string) {
    const now = Date.now()
    if (this.asking) return void this.h.log(`fall check-in already open, ignoring (${reason})`)
    if (reason !== "said" && now - this.lastStart < COOLDOWN_MS) return void this.h.log(`fall sensor ignored (cooldown): ${reason}`)
    this.lastStart = now
    this.asking = true
    this.h.log(`fall check-in (${reason})`)
    await this.h.say("Are you okay? Say I'm okay, or say help.")
    // Whoever answered during the question (asking can end early) is already handled.
    if (!this.asking) return
    this.timer = setTimeout(() => void this.finish("no response"), ASK_MS)
  }

  /** While a check-in is open, every utterance is an answer to it. Returns true if the text was consumed. */
  hear(norm: string): boolean {
    if (!this.asking) return false
    if (HELP.test(norm)) void this.finish("asked for help")
    else if (OK.test(norm)) void this.finish("ok")
    return true
  }

  private async finish(outcome: "ok" | "asked for help" | "no response") {
    if (!this.asking) return
    this.asking = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (outcome === "ok") {
      this.h.log("fall check-in: wearer is okay")
      return void (await this.h.say("Glad you're okay."))
    }
    const sent = await this.h.alert(outcome)
    this.h.log(`fall check-in: ${outcome}, family ${sent ? "notified" : "NOT reached"}`)
    await this.h.say(
      sent
        ? outcome === "asked for help" ? "Okay. I've told your family." : "No response. I've told your family."
        : "I could not reach your family. Please call someone now.",
    )
  }

  /** Feed one accelerometer reading (in g). Starts a check-in on free-fall, then impact, then stillness. */
  feed(x: number, y: number, z: number, at: number) {
    if (!this.firstReadingLogged) {
      this.firstReadingLogged = true
      this.h.log("accelerometer is streaming (fall sensor active)")
    }
    const m = Math.sqrt(x * x + y * y + z * z)
    this.samples.push({at, m})
    while (this.samples.length && at - this.samples[0].at > 4_000) this.samples.shift()

    if (m < FREE_FALL_G) this.freeFallAt = at
    if (m > IMPACT_G && this.freeFallAt && at - this.freeFallAt < IMPACT_WINDOW_MS) {
      this.impactAt = at
      this.freeFallAt = 0
    }
    if (this.impactAt && at - this.impactAt >= STILL_MS) {
      const after = this.samples.filter((s) => s.at > this.impactAt + 300)
      const still = after.length >= 5 && after.every((s) => Math.abs(s.m - 1) < STILL_BAND_G)
      this.impactAt = 0
      if (still) void this.start("impact then stillness")
    }
  }

  get streaming() {
    return this.firstReadingLogged
  }
}
