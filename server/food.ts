/**
 * Food Check (spec §6.2). Claude only READS the label (verbatim text, no judgement).
 * Plain code then compares it to the wearer's profile and today's date, so allergen and
 * date decisions are deterministic and testable.
 */
import {mentions, PROFILE} from "./profile"
import type {AnalyzeRequest, Severity, Verdict} from "../src/shared/types"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"

export interface LabelRead {
  isFood: boolean
  productName: string | null
  ingredientsText: string | null
  containsText: string | null
  mayContainText: string | null
  expiry: {text: string | null; date: string | null; kind: "use_by" | "best_by" | "expires" | "unknown"}
}

const SYSTEM = (today: string) => `You read food packaging for an older adult wearing camera glasses. Today is ${today}.
Reply with ONLY a JSON object:
{"isFood":true|false,"productName":string|null,"ingredientsText":string|null,"containsText":string|null,"mayContainText":string|null,"expiry":{"text":string|null,"date":"YYYY-MM-DD"|null,"kind":"use_by"|"best_by"|"expires"|"unknown"}}
Rules: copy label text verbatim. ingredientsText is the ingredients list, containsText is the "Contains:" line, mayContainText is the "May contain / processed in a facility with" line. Use null for anything not visible or not legible. Never guess or fill in from what such a product usually contains.
For the date: "use by"/"expires"/"exp" are use_by or expires, "best by"/"best before"/"BB" are best_by. If only month and year are shown, use the last day of that month. If the format is ambiguous (for example 03/04/25), set date to null but keep the text.
isFood is false if the photo does not show a food or drink item.`

const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`
const list = (xs: string[], word = "and") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${word} ${xs[xs.length - 1]}`)

/** Deterministic verdict from what the label says. Exported for tests. */
export function judge(label: LabelRead, today: Date, avoid = PROFILE.avoid): Verdict {
  const base = {skill: "food", source: "claude" as const, needsPhoto: false}
  if (!label.isFood) {
    return {...base, severity: "info", whisper: "This does not appear to be food. Please hold the package closer and try again.", needsCaregiver: false}
  }

  const parts: {sev: Severity; text: string}[] = []
  const evidence: {kind: string; detail: string}[] = []

  const ingredientText = [label.ingredientsText, label.containsText].filter(Boolean).join(" ")
  const hits = avoid.filter((a) => mentions(ingredientText, a))
  const maybe = avoid.filter((a) => !hits.includes(a) && mentions(label.mayContainText, a))
  if (hits.length) {
    parts.push({sev: "danger", text: `This contains ${list(hits)}, which you avoid.`})
    hits.forEach((a) => evidence.push({kind: "allergen", detail: `contains ${a}`}))
  }
  if (maybe.length) {
    parts.push({sev: "warn", text: `It may contain ${list(maybe)}.`})
    maybe.forEach((a) => evidence.push({kind: "allergen", detail: `may contain ${a}`}))
  }
  const ingredientsUnread = !label.ingredientsText && !label.containsText
  if (ingredientsUnread && !hits.length) parts.push({sev: "warn", text: "The ingredients could not be read."})

  let dateOk = false
  if (label.expiry.date) {
    const exp = new Date(`${label.expiry.date}T23:59:59`)
    const days = Math.floor((today.getTime() - exp.getTime()) / 86_400_000) + 1
    if (days > 0) {
      const hard = label.expiry.kind !== "best_by"
      parts.push({sev: hard ? "danger" : "warn", text: hard ? `It expired ${plural(days)} ago.` : `The best-by date passed ${plural(days)} ago.`})
      evidence.push({kind: "expiry", detail: `${label.expiry.kind} ${label.expiry.date}, ${plural(days)} past`})
    } else {
      dateOk = true
      evidence.push({kind: "expiry", detail: `${label.expiry.kind} ${label.expiry.date}, in date`})
    }
  } else {
    parts.push({sev: "warn", text: "No date could be read."})
  }

  const rank = {info: 0, warn: 1, danger: 2} as const
  const severity: Severity = parts.reduce<Severity>((m, p) => (rank[p.sev] > rank[m] ? p.sev : m), "info")
  parts.sort((a, b) => rank[b.sev] - rank[a.sev])

  const advice = severity === "danger" ? "Do not eat this." : severity === "warn" ? "Please check the label before eating." : "Please still check the label."
  const body = parts.length
    ? parts.slice(0, 2).map((p) => p.text).join(" ")
    : `No ${list(avoid, "or")} found on the label, and the date is fine.`

  const issues = parts.map((p) => p.text.replace(/\.$/, "")).join("; ")
  return {
    ...base,
    severity,
    whisper: `${body} ${advice}`,
    caregiverSummary: severity === "info" ? "Food check: no concerns found." : `Food check${label.productName ? ` (${label.productName})` : ""}: ${issues}.`,
    evidence,
    needsCaregiver: severity === "danger",
    source: "claude",
  }
}

const FAIL: Verdict = {
  skill: "food",
  severity: "warn",
  whisper: "Unable to check this food. Please read the label yourself for allergens and the date.",
  needsCaregiver: false,
  source: "fallback",
}

export async function analyzeFood(req: AnalyzeRequest): Promise<Verdict> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || !req.photoUrl) return FAIL
  try {
    const img = await fetch(req.photoUrl, {signal: AbortSignal.timeout(8000)})
    if (!img.ok) throw new Error(`photo download ${img.status}`)
    const type = img.headers.get("content-type")?.split(";")[0] ?? "image/jpeg"
    const data = Buffer.from(await img.arrayBuffer()).toString("base64")
    const today = new Date()
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM(today.toISOString().slice(0, 10)),
        messages: [{role: "user", content: [{type: "image", source: {type: "base64", media_type: type, data}}, {type: "text", text: "Read this label."}]}],
      }),
      signal: AbortSignal.timeout(25000),
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    const body = (await r.json()) as {content: {type: string; text?: string}[]}
    const text = body.content.find((c) => c.type === "text")?.text ?? ""
    const label = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as LabelRead
    label.expiry ??= {text: null, date: null, kind: "unknown"}
    return judge(label, today)
  } catch (e) {
    console.error("[food] failed:", (e as Error).message)
    return FAIL
  }
}
