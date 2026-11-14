import type {AnalyzeRequest, Verdict} from "../src/shared/types"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"
/** Text-only first pass is latency-critical, so it uses a faster model. */
const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-5-5"

const SCAM_SYSTEM = `You protect an older adult wearing camera glasses. You get a short transcript of what was just said near them and, sometimes, a photo of what they are looking at (screen, letter, ATM).
Decide whether they are being scammed. Common red flags: gift cards, wire transfer, crypto/Bitcoin ATM, urgency, secrecy ("don't tell anyone"), a caller claiming to be IRS/Social Security/Medicare/bank/tech support, remote-access requests, fake virus pop-ups, a grandchild "in trouble".
Reply with ONLY a JSON object:
{"classification":"scam"|"likely_scam"|"unclear"|"safe","redFlags":["short phrase"],"whisper":"<=20 words, calm, plain language, tells them what to do now","caregiverSummary":"one short sentence, no verbatim transcript","needsPhoto":true|false}
needsPhoto is true only if something VISIBLE would add information (a screen or pop-up, a letter, an email or text message, a website, an ATM, a QR code, a gift card). It is false when the scam is only spoken, such as a phone call.
Stay calm, never alarming. Don't quote the transcript. If unclear, whisper something cautious like "I'm not sure. Please pause and call your daughter before doing anything."`

function severityFor(classification: string, flags: number): Verdict["severity"] {
  if (classification === "scam" || flags >= 3) return "danger"
  if (classification === "likely_scam") return "warn"
  return "info"
}

/** Keyword fallback so the pipeline works with no API key or when the LLM call fails. */
function heuristic(req: AnalyzeRequest): Verdict {
  const t = req.transcriptWindow.toLowerCase()
  const checks: [string, RegExp][] = [
    ["untraceable payment", /gift card|wire transfer|bitcoin|crypto|western union/],
    ["secrecy", /don'?t tell|keep this (between|secret)/],
    ["urgency", /right now|immediately|urgent|arrest|suspended/],
    ["impersonation", /\birs\b|social security|medicare|microsoft|your bank|tech support/],
    ["remote access", /remote access|anydesk|teamviewer|virus/],
  ]
  const flags = checks.filter(([, re]) => re.test(t)).map(([name]) => name)
  const severity: Verdict["severity"] = flags.length >= 3 ? "danger" : flags.length >= 1 ? "warn" : "info"
  return {
    skill: req.skill,
    severity,
    whisper: flags.length
      ? "This looks like a scam. Don't pay or give any codes. I'm telling your family."
      : "I'm not sure. Please pause and check with your family first.",
    caregiverSummary: flags.length
      ? `Possible scam. Red flags: ${flags.join(", ")}.`
      : "Wearer asked for a scam check; nothing clear found.",
    evidence: flags.map((f) => ({kind: "red_flag", detail: f})),
    needsCaregiver: flags.length > 0,
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
      body: JSON.stringify({model: req.photoUrl ? MODEL : FAST_MODEL, max_tokens: 400, system: SCAM_SYSTEM, messages: [{role: "user", content}]}),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    const body = (await r.json()) as {content: {type: string; text?: string}[]}
    const text = body.content.find((c) => c.type === "text")?.text ?? ""
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
    }
  } catch (e) {
    console.error("[llm] failed, falling back to heuristic:", (e as Error).message)
    return heuristic(req)
  }
}
