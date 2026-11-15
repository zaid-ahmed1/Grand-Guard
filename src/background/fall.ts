/**
 * Fall response, started by the wearer's own words.
 *
 * In: the wearer says they fell ("I've fallen", "I can't get up"). We do not detect falls automatically: the glasses'
 * motion sensors are not available to miniapps, so nothing here watches movement.
 * Out: Ally asks "Are you okay?". "I'm okay" ends it. "Help", "no" or silence for 15 s tells the caregiver.
 * Nothing is sent without that check-in, and the wearer can always dismiss a false alarm by speaking.
 */

/** "I fell", "I've fallen", "I can't get up". Excludes figures of speech like "fell asleep". */
export const FALL_PHRASE =
  /\bi (have |just )*(fell|fallen)\b(?! (asleep|in love|for|behind|out of|off the wagon))|\bi'?ve (just )?(fallen|fell)\b|\bi (can'?t|cannot|couldn'?t) (get|stand) (back )?up\b|\bi (slipped|tripped) and (fell|fallen)\b|\bi (took|had) a fall\b/

const HELP = /\b(help|hurt|pain|ambulance|not (ok|okay|fine|alright)|can'?t (get up|move|stand))\b|^(no|nope|nah)\b/
const OK = /\b(i'?m|i am|im) (ok|okay|fine|alright|all right|good|not hurt)\b|\bfalse alarm\b|\bno need\b|^(yes|yeah|yep|ok|okay|fine)\b/

const ASK_MS = 15_000

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

  constructor(private h: FallHooks) {}

  get active() {
    return this.asking
  }

  /** Begin the check-in. Ignored while one is already open; saying you fell always starts one otherwise. */
  async start(reason: string) {
    if (this.asking) return void this.h.log(`fall check-in already open, ignoring (${reason})`)
    this.asking = true
    this.h.log(`fall check-in (${reason})`)
    await this.h.say("Are you okay? Say I'm okay, or say help.")
    // The wearer may have answered while the question was still being spoken.
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
        ? outcome === "asked for help"
          ? "Okay. I've told your family. Stay calm, help is on the way."
          : "No response. I've told your family. Stay calm, help is on the way."
        : "I could not reach your family. Please call someone now.",
    )
  }
}
