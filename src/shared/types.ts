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
