/**
 * Wearer-chosen wake word. On-device STT mangles names ("grand guard" -> "grand god"),
 * so matching is fuzzy: edit distance on the joined letters, tolerant of split or merged words.
 */
import {normalizeTranscript} from "./text"

export const DEFAULT_WAKE = "grand guard"

function lev(a: string, b: string): number {
  const d = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

const letters = (s: string) => normalizeTranscript(s).replace(/ /g, "")

/** Why this phrase would be a bad wake word, or null if it is fine. */
export function wakeIssue(phrase: string): string | null {
  if (letters(phrase).length < 4) return "Too short. It would trigger by accident. Use at least 4 letters."
  return null
}

/**
 * Find the wake word in an utterance. Returns the words spoken after it ("" if none), or null if absent.
 * Tolerance is 1 edit for short words and about 30% for longer ones.
 */
export function findWake(text: string, phrase: string): {rest: string} | null {
  const wake = normalizeTranscript(phrase)
  const joined = wake.replace(/ /g, "")
  if (joined.length < 4) return null
  const k = wake.split(" ").length
  const tol = joined.length >= 6 ? Math.floor(joined.length * 0.3) : 1
  const toks = normalizeTranscript(text).split(" ").filter(Boolean)
  for (let i = 0; i < toks.length; i++) {
    for (const n of [k, k - 1, k + 1]) {
      if (n < 1 || i + n > toks.length) continue
      if (lev(toks.slice(i, i + n).join(""), joined) <= tol) return {rest: toks.slice(i + n).join(" ")}
    }
  }
  return null
}
