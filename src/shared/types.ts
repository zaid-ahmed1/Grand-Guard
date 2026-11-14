/** Engine types shared by the miniapp background and the server (spec §5). */
export type Severity = "info" | "warn" | "danger"

export interface Verdict {
  skill: string
  severity: Severity
  /** <= 20 words, plain language, spoken to the wearer. */
  whisper: string
  caregiverSummary?: string
  evidence?: {kind: string; detail: string}[]
  needsCaregiver: boolean
  /** True when something visible (screen, letter, ATM) would add information. False for a pure phone/audio scam. */
  needsPhoto?: boolean
  /** Which brain produced this verdict. "fallback" means the keyword heuristic, not Claude. */
  source?: "claude" | "fallback" | "code"
  /** Caregiver feed event this verdict created or updated. */
  eventId?: string
}

export interface AnalyzeRequest {
  skill: string
  /** Rolling transcript window. Used for analysis only; never stored. */
  transcriptWindow: string
  /** Signed photo URL; the server downloads it (phone never handles image bytes). */
  photoUrl?: string
  /** Event id from the earlier text-only verdict; the photo result updates that event. */
  refines?: string
  /** Calendar skill: the phone's local date and time, "YYYY-MM-DDTHH:MM". The server does no time-zone math. */
  localNow?: string
  /** Calendar skill: "now" answers a question; "remind" returns a pre-event reminder (once per event) or an empty whisper. */
  query?: "now" | "remind"
}

export interface CalendarEvent {
  id: string
  title: string
  /** 24h "HH:MM", wearer's local time. */
  time: string
  endTime?: string
  /** "YYYY-MM-DD" for a one-off event. Omit when repeating. */
  date?: string
  repeat?: "daily" | "weekly"
  /** 0 = Sunday. Used when repeat is "weekly". */
  weekday?: number
  /** Free text such as "the bingo hall". */
  place?: string
  setBy: "caregiver" | "wearer"
}

export interface CaregiverEvent {
  id: string
  at: number
  skill: string
  severity: Severity
  whisper: string
  summary?: string
  evidence?: {kind: string; detail: string}[]
}
