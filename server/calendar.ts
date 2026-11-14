/**
 * Calendar (spec §6.5). Answers are built by plain code from the schedule and the phone's
 * clock. No LLM: it must never invent a time or place.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import type {CalendarEvent, Verdict} from "../src/shared/types"

const FILE = "./data/calendar.json"
const DEFAULT_LENGTH_MIN = 60
const REMIND_LEAD_MIN = 10
const SOON_MIN = 15

const SEED: CalendarEvent[] = [
  {id: "seed-breakfast", title: "Breakfast", time: "08:00", repeat: "daily", place: "in the kitchen", setBy: "caregiver"},
  {id: "seed-bingo", title: "Bingo", time: "14:00", endTime: "15:30", repeat: "daily", place: "at the bingo hall", setBy: "caregiver"},
  {id: "seed-dinner", title: "Dinner", time: "17:00", repeat: "daily", place: "in the dining room", setBy: "caregiver"},
  {id: "seed-call", title: "Phone call with Sarah", time: "19:00", repeat: "daily", setBy: "caregiver"},
]

let events: CalendarEvent[] = load()
const reminded = new Set<string>()

function load(): CalendarEvent[] {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf-8")) as CalendarEvent[]
  } catch (e) {
    console.warn("[calendar] could not read", FILE, (e as Error).message)
  }
  return [...SEED]
}

function save() {
  try {
    mkdirSync("./data", {recursive: true})
    writeFileSync(FILE, JSON.stringify(events, null, 2))
  } catch (e) {
    console.warn("[calendar] could not save:", (e as Error).message)
  }
}

export const listEvents = () => events

/** Returns an error message, or null if the event was added. */
export function addEvent(raw: Partial<CalendarEvent>, setBy: CalendarEvent["setBy"]): string | CalendarEvent {
  const title = String(raw.title ?? "").trim().slice(0, 80)
  if (!title) return "title is required"
  if (!/^\d{2}:\d{2}$/.test(raw.time ?? "")) return "time must be HH:MM"
  if (raw.endTime && !/^\d{2}:\d{2}$/.test(raw.endTime)) return "endTime must be HH:MM"
  if (raw.date && !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) return "date must be YYYY-MM-DD"
  if (!raw.date && !raw.repeat) return "set a date or a repeat"
  if (raw.repeat && !["daily", "weekly"].includes(raw.repeat)) return "repeat must be daily or weekly"
  if (raw.repeat === "weekly" && !(Number.isInteger(raw.weekday) && raw.weekday! >= 0 && raw.weekday! <= 6)) return "weekday must be 0-6"
  const ev: CalendarEvent = {
    id: crypto.randomUUID(),
    title,
    time: raw.time!,
    endTime: raw.endTime || undefined,
    date: raw.repeat ? undefined : raw.date,
    repeat: raw.repeat,
    weekday: raw.repeat === "weekly" ? raw.weekday : undefined,
    place: raw.place?.trim().slice(0, 80) || undefined,
    setBy,
  }
  events.push(ev)
  save()
  return ev
}

export function removeEvent(id: string): boolean {
  const n = events.length
  events = events.filter((e) => e.id !== id)
  if (events.length !== n) save()
  return events.length !== n
}

const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** "14:00" -> "2 PM", "14:30" -> "2:30 PM". */
export function fmtTime(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(3, 5))
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`
}

function occursOn(e: CalendarEvent, date: string, weekday: number): boolean {
  if (e.repeat === "daily") return true
  if (e.repeat === "weekly") return e.weekday === weekday
  return e.date === date
}

/** The place text may carry its own preposition ("in the kitchen"); otherwise use "at". */
const placeOf = (e: CalendarEvent, comma: boolean) => {
  if (!e.place) return ""
  const p = /^(at|in|on|by|near|inside|outside|upstairs|downstairs)\s/i.test(e.place) ? e.place : `at ${e.place}`
  return `${comma ? ", " : " "}${p}`
}
const addedBy = (e: CalendarEvent) => (e.setBy === "caregiver" ? " Added by your family." : " You added this.")
const plural = (n: number) => `${n} minute${n === 1 ? "" : "s"}`

/** Split "YYYY-MM-DDTHH:MM" into parts. Weekday comes from the date alone, so no time-zone math is needed. */
function parseNow(localNow: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localNow)
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  return {date, nowMin: Number(m[4]) * 60 + Number(m[5]), weekday: new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()}
}

/** Pure function so it can be tested with fixed times. */
export function answerNow(list: CalendarEvent[], localNow: string): string | null {
  const t = parseNow(localNow)
  if (!t) return null
  const today = list.filter((e) => occursOn(e, t.date, t.weekday)).sort((a, b) => mins(a.time) - mins(b.time))
  const end = (e: CalendarEvent) => (e.endTime ? mins(e.endTime) : mins(e.time) + DEFAULT_LENGTH_MIN)
  const current = today.filter((e) => mins(e.time) <= t.nowMin && t.nowMin < end(e))

  if (current.length === 1) {
    const e = current[0]
    return `Right now, you have ${e.title}${placeOf(e, false)}. It started at ${fmtTime(e.time)}.${addedBy(e)}`
  }
  if (current.length > 1) {
    const [a, b] = current
    return `Right now, you have ${a.title}${placeOf(a, false)}, and ${b.title}${placeOf(b, false)}.`
  }
  const next = today.find((e) => mins(e.time) > t.nowMin)
  if (!next) return today.length ? "Nothing else is planned today." : "Nothing is planned today."
  const away = mins(next.time) - t.nowMin
  if (away <= SOON_MIN) return `${next.title} starts in ${plural(away)}${placeOf(next, true)}.`
  return `Nothing is planned right now. Next is ${next.title} at ${fmtTime(next.time)}${placeOf(next, true)}.`
}

/** Reminder text for an event starting within the lead time that has not been announced yet, else "". Marks it announced. */
export function takeReminder(list: CalendarEvent[], localNow: string): string {
  const t = parseNow(localNow)
  if (!t) return ""
  for (const e of list.filter((x) => occursOn(x, t.date, t.weekday)).sort((a, b) => mins(a.time) - mins(b.time))) {
    const away = mins(e.time) - t.nowMin
    const key = `${e.id}:${t.date}`
    if (away > 0 && away <= REMIND_LEAD_MIN && !reminded.has(key)) {
      reminded.add(key)
      return `${e.title} starts in ${plural(away)}${placeOf(e, true)}.`
    }
  }
  return ""
}

export function calendarVerdict(query: "now" | "remind", localNow: string | undefined): Verdict {
  const base = {skill: "calendar", severity: "info" as const, needsCaregiver: false, source: "code" as const}
  if (!localNow) return {...base, whisper: "Unable to read the calendar right now. Please ask a family member."}
  if (query === "remind") return {...base, whisper: takeReminder(events, localNow)}
  const w = answerNow(events, localNow)
  return {...base, whisper: w ?? "Unable to read the calendar right now. Please ask a family member."}
}
