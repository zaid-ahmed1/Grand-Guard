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
}

export interface AnalyzeRequest {
  skill: string
  /** Rolling transcript window. Used for analysis only; never stored. */
  transcriptWindow: string
  /** Signed photo URL; the server downloads it (phone never handles image bytes). */
  photoUrl?: string
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
