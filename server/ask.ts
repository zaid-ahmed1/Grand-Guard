/**
 * "Ask Grand Guard": a discreet helper for things people hesitate to ask a person about
 * (small print, paperwork, devices). Private by default: nothing goes to the caregiver
 * feed unless the item looks like a scam.
 */
import {thinkingOff} from "./anthropic"
import type {AnalyzeRequest, Verdict} from "../src/shared/types"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5"
const FAST_MODEL = process.env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-5-5"

const SYSTEM = `You are a discreet assistant speaking quietly into the ear of an older adult who wears camera glasses. They asked a question, often about what they are looking at (a photo may be attached). They are capable and independent. Never be condescending, never mention age or ability.
Answer in plain, respectful language with no jargon. Your reply is spoken aloud, so use at most 35 words in short sentences.
- If asked to read something, give the most important parts (who it is from, the amount, the date, what is being asked), not every word.
- If asked how to use a device, give only the next single step.
- If you cannot see or read it, say so and say what to adjust, for example "Please hold it closer and in better light."
- For health information, explain the words and suggest asking the doctor or pharmacist. Never diagnose.
- If the item or the question involves urgent demands for money, codes or personal details, set scamSuspected to true and end with "This could be a scam. Please check with someone before replying."
Reply with ONLY a JSON object: {"whisper":"...","scamSuspected":true|false}`

const FAIL: Verdict = {
  skill: "ask",
  severity: "info",
  whisper: "Unable to answer that right now. Please try again.",
  needsCaregiver: false,
  source: "fallback",
}

export async function analyzeAsk(req: AnalyzeRequest): Promise<Verdict> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return FAIL
  try {
    const content: unknown[] = []
    if (req.photoUrl) {
      const img = await fetch(req.photoUrl, {signal: AbortSignal.timeout(8000)})
      if (!img.ok) throw new Error(`photo download ${img.status}`)
      const type = img.headers.get("content-type")?.split(";")[0] ?? "image/jpeg"
      content.push({type: "image", source: {type: "base64", media_type: type, data: Buffer.from(await img.arrayBuffer()).toString("base64")}})
    }
    content.push({type: "text", text: `The wearer said: "${req.transcriptWindow}"`})
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
      body: JSON.stringify({model: req.photoUrl ? MODEL : FAST_MODEL, thinking: thinkingOff(req.photoUrl ? MODEL : FAST_MODEL), max_tokens: 1200, system: SYSTEM, messages: [{role: "user", content}]}),
      signal: AbortSignal.timeout(20000),
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    const body = (await r.json()) as {content: {type: string; text?: string}[]}
    const text = body.content.find((c) => c.type === "text")?.text ?? ""
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {whisper: string; scamSuspected?: boolean}
    const scam = j.scamSuspected === true
    return {
      skill: "ask",
      severity: scam ? "warn" : "info",
      whisper: j.whisper,
      caregiverSummary: scam ? "The wearer looked at something that may be a scam." : undefined,
      needsCaregiver: scam,
      source: "claude",
    }
  } catch (e) {
    console.error("[ask] failed:", (e as Error).message)
    return FAIL
  }
}
