/**
 * Router: one fast Claude Haiku call that picks a tool for a request whose phrasing the local
 * phrase matching could not handle ("what do I have at 5pm", "put dentist on Tuesday at 3").
 * The model only CHOOSES a tool and fills in its parameters. Schedule answers are still built by
 * plain code (calendar.ts), so it cannot invent a time or place.
 */
import {thinkingOff} from "./anthropic"
import {addEventDraft} from "./calendar"
import {answerQuery, describeEvent, listEvents, todayOf} from "./calendar"
import type {AnalyzeRequest, CalendarEvent, Verdict} from "../src/shared/types"

/** Its own setting: the router forces a tool call, which Sonnet does not support, so it must stay on Haiku. */
const FAST_MODEL = process.env.ANTHROPIC_MODEL_ROUTER ?? "claude-haiku-5-5"
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const str = (description: string) => ({type: "string", description})
const TOOLS = [
  {
    name: "check_calendar",
    description:
      "Look up the wearer's schedule. Use for any question about what they have, what is next, what is on at a given time or day, or whether they are free. Omit both fields for 'what is happening now or next'.",
    input_schema: {type: "object", properties: {date: str("YYYY-MM-DD, only if a day was mentioned (resolve 'tomorrow', 'Monday')"), time: str("HH:MM 24-hour, ONLY if a specific clock time was said ('5pm' is 17:00). For vague parts of the day such as morning, afternoon or evening, omit it")}},
  },
  {
    name: "add_calendar_event",
    description: "The wearer asked to add a reminder or event to their schedule ('remind me to call Sam at 3', 'put dentist on Tuesday at 10').",
    input_schema: {
      type: "object",
      properties: {
        title: str("Short title, for example 'Call Sam'"),
        time: str("HH:MM 24-hour"),
        date: str("YYYY-MM-DD. Omit if it repeats. Omit for today."),
        repeat: {type: "string", enum: ["daily", "weekly"]},
        weekday: {type: "integer", description: "0 = Sunday, only with repeat weekly"},
        place: str("Optional place, with its preposition, for example 'at the pharmacy'"),
      },
      required: ["title", "time"],
    },
  },
  {name: "tell_time", description: "They asked what time or what day it is.", input_schema: {type: "object", properties: {}}},
  {name: "check_food", description: "They want to know if a food, leftover or package they are holding is safe to eat, contains an allergen, or is expired.", input_schema: {type: "object", properties: {}}},
  {name: "scam_check", description: "They want to know whether a call, message, letter, website or person is a scam or trustworthy.", input_schema: {type: "object", properties: {}}},
  {name: "repeat_last", description: "They did not hear or understand what was just said and want it repeated.", input_schema: {type: "object", properties: {}}},
  {
    name: "look_and_answer",
    description: "Reading or explaining something visible: a letter, label, sign, menu, screen, bill or a device they cannot work. Takes a photo.",
    input_schema: {type: "object", properties: {question: str("What they want to know, in their words")}, required: ["question"]},
  },
  {
    name: "answer",
    description: "A general question that needs no photo and no schedule. Reply in at most 35 words, plain and respectful, never condescending. Never use this for schedule facts or medical advice.",
    input_schema: {type: "object", properties: {whisper: str("The spoken reply")}, required: ["whisper"]},
  },
  {name: "not_for_me", description: "The speech is not a request to the assistant (ordinary conversation).", input_schema: {type: "object", properties: {}}},
]

const SYSTEM = (localNow: string) => {
  const d = new Date(Date.UTC(Number(localNow.slice(0, 4)), Number(localNow.slice(5, 7)) - 1, Number(localNow.slice(8, 10))))
  return `You route spoken requests from an older adult wearing camera glasses. Today is ${DAYS[d.getUTCDay()]} ${localNow.slice(0, 10)} and the local time is ${localNow.slice(11, 16)}.
Pick exactly one tool. Phrasing may be unclear or ungrammatical, so infer the intent. Resolve relative days to YYYY-MM-DD and times to 24-hour HH:MM. Anything about their schedule goes to check_calendar, never answer. If it concerns something they are looking at, use look_and_answer.`
}

const base = {skill: "route", severity: "info" as const, needsCaregiver: false, source: "claude" as const}
/** Used when the router cannot run: the glasses fall back to the general Ask skill. */
const FALLBACK: Verdict = {...base, whisper: "", action: "ask", source: "fallback"}

export async function routeRequest(req: AnalyzeRequest): Promise<Verdict> {
  const key = process.env.ANTHROPIC_API_KEY
  const now = req.localNow
  if (!key || !now || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(now)) return {...FALLBACK, question: req.transcriptWindow}
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
      body: JSON.stringify({
        model: FAST_MODEL,
        thinking: thinkingOff(FAST_MODEL),
        max_tokens: 1000,
        system: SYSTEM(now),
        tools: TOOLS,
        tool_choice: {type: "any"},
        messages: [{role: "user", content: `The wearer said: "${req.transcriptWindow}"`}],
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`)
    const body = (await r.json()) as {content: {type: string; name?: string; input?: Record<string, unknown>}[]}
    const call = body.content.find((c) => c.type === "tool_use")
    if (!call?.name) throw new Error("no tool call")
    return execute(call.name, call.input ?? {}, req, now)
  } catch (e) {
    console.error("[router] failed:", (e as Error).message)
    return {...FALLBACK, question: req.transcriptWindow}
  }
}

function execute(name: string, a: Record<string, unknown>, req: AnalyzeRequest, now: string): Verdict {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : undefined)
  switch (name) {
    case "check_calendar": {
      const w = answerQuery(listEvents(), now, s("date"), s("time"))
      return {...base, whisper: w ?? "Unable to read the calendar right now. Please ask a family member.", action: "speak", source: "code"}
    }
    case "add_calendar_event": {
      const draft = addEventDraft({
        title: s("title"),
        time: s("time"),
        date: s("date"),
        repeat: s("repeat") as CalendarEvent["repeat"],
        weekday: typeof a.weekday === "number" ? a.weekday : undefined,
        place: s("place"),
      }, todayOf(now)!)
      if (typeof draft === "string") return {...base, whisper: "Please say what and when, for example: remind me to call Sam at 3 PM.", action: "speak", source: "code"}
      return {...base, whisper: `Add ${describeEvent(draft, todayOf(now)!)}? Say yes or no.`, action: "confirm_add", event: draft, source: "code"}
    }
    case "tell_time": return {...base, whisper: "", action: "clock"}
    case "check_food": return {...base, whisper: "", action: "food"}
    case "scam_check": return {...base, whisper: "", action: "scam"}
    case "repeat_last": return {...base, whisper: "", action: "repeat"}
    case "look_and_answer": return {...base, whisper: "", action: "ask", needsPhoto: true, question: s("question") ?? req.transcriptWindow}
    case "answer": return {...base, whisper: s("whisper") ?? "", action: s("whisper") ? "speak" : "none"}
    default: return {...base, whisper: "", action: "none"}
  }
}
