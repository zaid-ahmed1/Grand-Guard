/**
 * Debug view: the last photo each skill analysed, kept in MEMORY ONLY so a developer can see what the AI saw.
 * Never written to disk, never sent to the caregiver feed, and only served to the laptop itself (see index.ts),
 * not through the public tunnel. Set DEBUG_PHOTOS=0 to turn it off.
 */
const ON = process.env.DEBUG_PHOTOS !== "0"

interface Last {
  at: number
  skill: string
  type: string
  data: string
  note?: unknown
}
let last: Last | null = null

export const rememberPhoto = (skill: string, type: string, data: string) => {
  if (ON) last = {at: Date.now(), skill, type, data}
}
/** What the AI read and decided for the photo just stored. */
export const rememberNote = (skill: string, note: unknown) => {
  if (ON && last && last.skill === skill) last.note = note
}
export const lastPhoto = () => last

/** True only for a request made on the laptop itself: a localhost Host header and no proxy headers (the tunnel adds them). */
export function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host") ?? ""
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && !req.headers.get("cf-connecting-ip") && !req.headers.get("x-forwarded-for")
}
