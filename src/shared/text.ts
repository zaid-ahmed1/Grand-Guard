/**
 * Normalise speech-to-text output before keyword matching. On-device STT often
 * spells acronyms out ("i r s", "a t m") and splits words ("to day").
 */
export function normalizeTranscript(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // "i r s" -> "irs", "a t m" -> "atm" (runs of 2+ single letters)
      .replace(/\b(?:[a-z] )+[a-z]\b/g, (m) => m.replace(/ /g, ""))
  )
}
