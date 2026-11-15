/**
 * Food Check (spec §6.2). Claude only READS the label (verbatim text, no judgement).
 * Plain code then compares it to the wearer's profile and today's date, so allergen and
 * date decisions are deterministic and testable.
 */
import {downloadPhoto, thinkingOff} from "./anthropic"
import {rememberNote, rememberPhoto} from "./debug"
import {mentions, PROFILE} from "./profile"
import type {AnalyzeRequest, Severity, Verdict} from "../src/shared/types"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"

export interface LabelRead {
  isFood: boolean
  productName: string | null
  /** Verbatim words on the FRONT of the pack that say what the food is (variety, flavour, form), e.g. "Mozzarella string cheese". */
  frontText?: string | null
  ingredientsText: string | null
  containsText: string | null
  mayContainText: string | null
  expiry: {text: string | null; date: string | null; kind: "use_by" | "best_by" | "expires" | "unknown"}
}

const SYSTEM = (today: string) => `You read food packaging for an older adult wearing camera glasses. Today is ${today}.
Reply with ONLY a JSON object:
{"isFood":true|false,"productName":string|null,"frontText":string|null,"ingredientsText":string|null,"containsText":string|null,"mayContainText":string|null,"expiry":{"text":string|null,"date":"YYYY-MM-DD"|null,"kind":"use_by"|"best_by"|"expires"|"unknown"}}
Rules: copy label text verbatim. frontText is the wording on the front of the pack that says what the food is, such as the variety, flavour or form ("Mozzarella string cheese", "Peanut butter cups"). Copy only words printed on the pack. ingredientsText is the ingredients list, containsText is the "Contains:" line, mayContainText is the "May contain / processed in a facility with" line. Use null for anything not visible or not legible. Never guess or fill in from what such a product usually contains.
For the date: "use by"/"expires"/"exp" are use_by or expires, "best by"/"best before"/"BB" are best_by. If only month and year are shown, use the last day of that month. If the format is ambiguous (for example 03/04/25), set date to null but keep the text.
isFood is false if the photo does not show a food or drink item.`

/**
 * What a kind of food usually holds, for when the ingredients cannot be read but the name is clear. Hedged advice
 * only, never a verdict: "usually" are allergens the food normally contains, "watch" are common cross-contact ones.
 */
const KINDS: {re: RegExp; usually: string[]; watch: string[]; always?: Record<string, string>}[] = [
  // "always": dishes that are made with an allergen by definition, so the answer needs no label. The phrase is what is said aloud.
  {re: /pizza/i, usually: [], watch: ["peanuts", "tree nuts", "soy"], always: {milk: "has cheese, which is dairy", wheat: "has a wheat crust"}},
  {re: /lasagn|macaroni|mac and|quesadilla/i, usually: [], watch: ["peanuts", "tree nuts", "soy"], always: {milk: "has cheese, which is dairy", wheat: "is made with wheat"}},
  {re: /pretzel/i, usually: ["wheat"], watch: ["peanuts", "tree nuts", "sesame", "milk", "soy"]},
  {re: /cracker|chips?|crisps|popcorn/i, usually: [], watch: ["peanuts", "tree nuts", "wheat", "milk", "soy"]},
  {re: /cookie|biscuit|brownie|cake|muffin|pastry|donut|doughnut/i, usually: ["wheat", "eggs", "milk"], watch: ["peanuts", "tree nuts", "soy"]},
  {re: /candy|chocolate|granola|trail mix|bar/i, usually: [], watch: ["peanuts", "tree nuts", "milk", "soy", "wheat"]},
]

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
  const maybe = avoid.filter((a) => !hits.includes(a) && mentions(label.mayContainText, a) && !mentions([label.productName, label.frontText].filter(Boolean).join(" "), a))
  if (hits.length) {
    parts.push({sev: "danger", text: `This contains ${list(hits)}, which you avoid.`})
    hits.forEach((a) => evidence.push({kind: "allergen", detail: `contains ${a}`}))
  }
  if (maybe.length) {
    parts.push({sev: "warn", text: `It may contain ${list(maybe)}.`})
    maybe.forEach((a) => evidence.push({kind: "allergen", detail: `may contain ${a}`}))
  }
  // The pack's own name can make an allergen obvious even when the ingredients cannot be read ("String Cheese" is dairy).
  // Only printed words are matched, never what a brand usually contains.
  const named = [label.productName, label.frontText].filter(Boolean).join(" ")
  const implied = avoid.filter((a) => !hits.includes(a) && mentions(named, a))
  if (implied.length) {
    const name = label.productName || label.frontText!
    // A free-from claim ("vegan", "dairy-free") makes the name unreliable, so ask for a label check instead of a flat no.
    const claim = /vegan|dairy[- ]free|non[- ]dairy|plant[- ]based|egg[- ]free|nut[- ]free|peanut[- ]free/i.test(named)
    parts.push(claim
      ? {sev: "warn", text: `The package says ${name}, which can contain ${list(implied)}. It also makes a free-from claim, so check the label.`}
      : {sev: "danger", text: `The package says ${name}. That contains ${list(implied)}, which you avoid.`})
    implied.forEach((a) => evidence.push({kind: "allergen", detail: `implied by package name (${name}): ${a}`}))
  }
  const ingredientsUnread = !label.ingredientsText && !label.containsText
  // A dish that always contains an allergen (pizza has cheese) is answered from what it is, when its ingredients cannot be read.
  const kind = KINDS.find((k) => k.re.test(named))
  const typical = ingredientsUnread && kind?.always ? avoid.filter((a) => !hits.includes(a) && !implied.includes(a) && kind.always![a]) : []
  if (typical.length) {
    const name = (label.productName || label.frontText || "This dish").replace(/^./, (c) => c.toUpperCase())
    const claim = /vegan|dairy[- ]free|non[- ]dairy|plant[- ]based|gluten[- ]free|egg[- ]free/i.test(named)
    const phrase = kind!.always![typical[0]]
    parts.push(claim
      ? {sev: "warn", text: `${name} usually ${phrase}, but it makes a free-from claim, so check the ingredients.`}
      : {sev: "danger", text: `${name} ${phrase}. You avoid ${list(typical)}.`})
    typical.forEach((a) => evidence.push({kind: "allergen", detail: `typical of ${name}: ${a}`}))
  }
  if (!ingredientsUnread && !hits.length && !maybe.length && !implied.length) {
    parts.push({sev: "info", text: `No ${list(avoid, "or")} in the ingredients.`})
  }
  const known = label.productName || label.frontText
  if (ingredientsUnread && !hits.length && !typical.length) {
    if (known && kind && !implied.length) {
      // The food is recognisable but the ingredients are not readable: say what to watch for, from the wearer's own list.
      const usually = avoid.filter((a) => kind.usually.includes(a))
      const watch = avoid.filter((a) => kind.watch.includes(a) && !usually.includes(a))
      const rest = avoid.filter((a) => !usually.includes(a) && !watch.includes(a))
      const text = [
        `This looks like ${known.toLowerCase()}.`,
        usually.length ? `These usually contain ${list(usually)}.` : rest.length ? `These probably don't contain ${list(rest, "or")}.` : "",
        watch.length ? `Watch for ${list(watch, "or")}.` : "",
        "The ingredients could not be read.",
      ].filter(Boolean).join(" ")
      parts.push({sev: "warn", text})
      evidence.push({kind: "allergen", detail: `ingredients unread; recognised as ${known}`})
    } else {
      parts.push({sev: "warn", text: known && !implied.length ? `This looks like ${known.toLowerCase()}, but the ingredients could not be read.` : "The ingredients could not be read."})
    }
  }
  // Nothing readable at all, not even what the food is: the photo is too far away or too small.
  const unreadable = ingredientsUnread && !label.expiry.date && !hits.length && !implied.length && !typical.length && !known

  let dateOk = false
  const noDate = !label.expiry.date
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
  }
  // An unreadable date is not announced. It only changes the closing advice below.

  if (unreadable) {
    parts.length = 0
    parts.push({sev: "warn", text: "The label is too small to read. Hold it about a hand's length from the glasses."})
  }
  const rank = {info: 0, warn: 1, danger: 2} as const
  const severity: Severity = parts.reduce<Severity>((m, p) => (rank[p.sev] > rank[m] ? p.sev : m), "info")
  parts.sort((a, b) => rank[b.sev] - rank[a.sev])
  // The allergen result leads when the ingredients were read and are clean; only the date is missing.
  const clean = parts.findIndex((x) => x.sev === "info" && x.text.endsWith("in the ingredients."))
  if (clean > 0) parts.unshift(...parts.splice(clean, 1))

  const advice = severity === "danger" ? "Do not eat this." : severity === "warn" ? "Please check the label before eating." : noDate ? "Make sure to check the expiry date." : "Please still check the label."
  const body = parts.length
    ? parts.slice(0, 3).map((p) => p.text).join(" ")
    : `No ${list(avoid, "or")} found on the label, and the date is fine.`

  const issues = parts.map((p) => p.text.replace(/\.$/, "")).join("; ")
  return {
    ...base,
    severity,
    whisper: `${body} ${advice}`,
    // The caregiver gets the gist only: what was asked about and what the wearer was told, not the label details.
    caregiverSummary: `Asked about ${known || "a food"}. Responded: ${severity === "danger" ? "do not eat this" : severity === "warn" ? "check the label" : "no concerns found"}.`,
    evidence,
    needsCaregiver: severity === "danger",
    unreadable,
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
    const {type, data} = await downloadPhoto(req.photoUrl)
    rememberPhoto("food", type, data)
    const today = new Date()
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
      body: JSON.stringify({
        model: MODEL,
        thinking: thinkingOff(MODEL),
        max_tokens: 2500,
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
    const verdict = judge(label, today)
    rememberNote("food", {labelRead: label, verdict: {severity: verdict.severity, whisper: verdict.whisper}})
    return verdict
  } catch (e) {
    console.error("[food] failed:", (e as Error).message)
    return FAIL
  }
}
