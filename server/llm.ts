import {thinkingOff} from "./anthropic"
import {rememberPhoto} from "./debug"
import {normalizeTranscript} from "../src/shared/text"
import type {AnalyzeRequest, Verdict} from "../src/shared/types"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"
/** Text-only first pass is latency-critical, so it uses a faster model. */
const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-5-5"

const SCAM_SYSTEM = `You protect an older adult wearing camera glasses. You get a short transcript of what was just said near them and, sometimes, a photo of what they are looking at (screen, letter, ATM).
Decide whether they are being scammed. Common red flags: gift cards, wire transfer, crypto/Bitcoin ATM, urgency, secrecy ("don't tell anyone"), a caller claiming to be IRS/Social Security/Medicare/bank/tech support, remote-access requests, fake virus pop-ups, a grandchild "in trouble".
Red-flag words alone are not enough. Judge context: someone buying a gift card as a present, or family talking normally, is "safe". A scam needs pressure, secrecy, or a stranger or caller asking for money, codes or personal details. The transcript may include several minutes of unrelated speech; judge the most recent statements and who is speaking. If a "Most recent statement" is marked, base the verdict on it; earlier lines are only context. A harmless statement (a question about their own day, the time, the schedule) is "safe" even if earlier lines sounded like a scam. Do not assume the wearer's relationship to anyone: say "a family member", never "grandchild".
Reply with ONLY a JSON object:
{"classification":"scam"|"likely_scam"|"unclear"|"safe","redFlags":["short phrase"],"whisper":"<=12 words, calm, plain language, tells them what to do now","caregiverSummary":"one short sentence, no verbatim transcript","needsPhoto":true|false}
needsPhoto is true only if something VISIBLE would add information (a screen or pop-up, a letter, an email or text message, a website, an ATM, a QR code, a gift card). It is false when the scam is only spoken, such as a phone call.
Whisper style: professional, calm and matter-of-fact, like a bank's fraud desk. Short declarative sentences. No exclamation marks, no emotive words, no slang, no first person ("I"), and never claim to take actions such as calling or telling anyone. State what this appears to be, then the one thing to do. Good examples: "This appears to be a scam. Do not send money or share any codes. Please hang up." / "The IRS does not request payment by gift card. Do not continue this call." Don't quote the transcript. If unclear: "This may not be safe. Please pause and check with a family member before continuing."`

function severityFor(classification: string, flags: number): Verdict["severity"] {
  if (classification === "scam" || flags >= 3) return "danger"
  if (classification === "likely_scam") return "warn"
  return "info"
}

/** Keyword fallback so the pipeline works with no API key or when the LLM call fails. */
function heuristic(req: AnalyzeRequest): Verdict {
  const t = normalizeTranscript(req.transcriptWindow)
  const checks: [string, RegExp][] = [
    ["untraceable payment", /gift card|wire transfer|bitcoin|crypto|western union|(send|wire|transfer|mail|give|pay).{0,15}(money|cash)/],
    ["secrecy", /don'?t tell|keep this (between|secret)/],
    ["urgency", /right now|immediately|urgent|arrest|suspended/],
    ["impersonation", /\birs\b|social security|medicare|microsoft|your bank|tech support/],
    ["remote access", /remote access|anydesk|teamviewer|virus/],
    ["asks for sensitive details", /social security (number|digits)|\bssn\b|credit card|debit card|card number|\bcvv\b|security code/],
  ]
  const flags = checks.filter(([, re]) => re.test(t)).map(([name]) => name)
  const severity: Verdict["severity"] = flags.length >= 3 ? "danger" : flags.length >= 1 ? "warn" : "info"
  return {
    skill: req.skill,
    severity,
    whisper: flags.length
      ? "This appears to be a scam. Do not send money or share any codes. Please hang up."
      : "This may not be safe. Please pause and check with a family member before continuing.",
    caregiverSummary: flags.length
      ? `Possible scam. Red flags: ${flags.join(", ")}.`
      : "Wearer asked for a scam check; nothing clear found.",
    evidence: flags.map((f) => ({kind: "red_flag", detail: f})),
    needsCaregiver: flags.length > 0,
    source: "fallback",
    needsPhoto: /screen|pop-?up|computer|laptop|letter|e-?mail|text message|website|atm|qr|look at/.test(t),
  }
}

async function fetchImage(url: string) {
  const r = await fetch(url, {signal: AbortSignal.timeout(8000)})
  if (!r.ok) throw new Error(`photo download ${r.status}`)
  const type = r.headers.get("content-type")?.split(";")[0] ?? "image/jpeg"
  return {type, data: Buffer.from(await r.arrayBuffer()).toString("base64")}
}

export async function analyzeScam(req: AnalyzeRequest): Promise<Verdict> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    console.warn("[llm] no ANTHROPIC_API_KEY, using keyword heuristic")
    return heuristic(req)
  }

  const content: unknown[] = []
  if (req.photoUrl) {
    try {
      const img = await fetchImage(req.photoUrl)
      rememberPhoto("scam", img.type, img.data)
      content.push({type: "image", source: {type: "base64", media_type: img.type, data: img.data}})
    } catch (e) {
      console.warn("[llm] photo skipped:", (e as Error).message)
    }
  }
  content.push({type: "text", text: `Transcript of the last minute:\n"""${req.transcriptWindow || "(nothing heard)"}"""`})

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
      body: JSON.stringify({model: req.photoUrl ? MODEL : FAST_MODEL, thinking: thinkingOff(req.photoUrl ? MODEL : FAST_MODEL), max_tokens: 1500, system: SCAM_SYSTEM, messages: [{role: "user", content}]}),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    const body = (await r.json()) as {content: {type: string; text?: string}[]}
    const text = body.content.find((c) => c.type === "text")?.text ?? ""
    if (!text) throw new Error(`no text in reply (stop_reason ${(body as {stop_reason?: string}).stop_reason})`)
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
      classification: string
      redFlags?: string[]
      whisper: string
      caregiverSummary?: string
      needsPhoto?: boolean
    }
    const flags = j.redFlags ?? []
    const severity = severityFor(j.classification, flags.length)
    return {
      skill: req.skill,
      severity,
      whisper: j.whisper,
      caregiverSummary: j.caregiverSummary,
      evidence: flags.map((f) => ({kind: "red_flag", detail: f})),
      needsCaregiver: severity !== "info",
      needsPhoto: j.needsPhoto === true,
      source: "claude",
    }
  } catch (e) {
    console.error("[llm] failed, falling back to heuristic:", (e as Error).message)
    return heuristic(req)
  }
}
