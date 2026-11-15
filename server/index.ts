/** Grand Guard backend: /analyze, /events (+SSE), static caregiver page. */
import {analyzeScam} from "./llm"
import {analyzeFood} from "./food"
import {analyzeAsk} from "./ask"
import {addEvent, calendarVerdict, listEvents, removeEvent} from "./calendar"
import {routeRequest} from "./router"
import {isLocalRequest, lastPhoto} from "./debug"
import {ALLERGEN_OPTIONS, PROFILE, setAvoid} from "./profile"
import type {AnalyzeRequest, CaregiverEvent, Verdict} from "../src/shared/types"

const PORT = Number(process.env.PORT ?? 8787)
const events: CaregiverEvent[] = []
const clients = new Set<ReadableStreamDefaultController<string>>()
const cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS"}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {status, headers: {"content-type": "application/json", ...cors}})

const chat: {id: number; at: number; role: "you" | "guard"; text: string}[] = []
let chatId = 0

/** A possible fall, decided by code on the glasses side: the wearer said so, asked for help, or did not answer a check-in. */
function fallVerdict(reason: string): Verdict {
  return {
    skill: "fall",
    severity: "danger",
    whisper: "",
    caregiverSummary: `Possible fall. ${reason === "asked for help" ? "The wearer asked for help." : "The wearer did not respond to a check-in."} Please check on them now.`,
    needsCaregiver: true,
    source: "code",
  }
}

const rank = {info: 0, warn: 1, danger: 2} as const

function broadcast(ev: CaregiverEvent) {
  for (const c of clients) {
    try {
      c.enqueue(`data: ${JSON.stringify(ev)}

`)
    } catch {
      clients.delete(c)
    }
  }
}

/** Create a feed event, or update the one this verdict refines (same id, so clients replace it). */
function publish(v: Verdict, refines?: string): string {
  const existing = refines ? events.find((e) => e.id === refines) : undefined
  if (existing) {
    if (rank[v.severity] >= rank[existing.severity]) {
      existing.severity = v.severity
      existing.whisper = v.skill === "food" ? "" : v.whisper
    }
    existing.summary = v.caregiverSummary ?? existing.summary
    existing.evidence = v.evidence ?? existing.evidence
    broadcast(existing)
    return existing.id
  }
  const ev: CaregiverEvent = {
    id: crypto.randomUUID(),
    at: Date.now(),
    skill: v.skill,
    severity: v.severity,
    // Food events carry only the short summary, never the spoken label details.
    whisper: v.skill === "food" ? "" : v.whisper,
    summary: v.caregiverSummary,
    evidence: v.skill === "food" ? undefined : v.evidence,
  }
  events.unshift(ev)
  events.length = Math.min(events.length, 200)
  broadcast(ev)
  return ev.id
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "OPTIONS") return new Response(null, {headers: cors})

    if (url.pathname === "/analyze" && req.method === "POST") {
      const t0 = Date.now()
      const body = (await req.json()) as AnalyzeRequest
      if (!["scam", "food", "ask", "calendar", "route", "fall"].includes(body.skill)) return json({error: `unknown skill ${body.skill}`}, 400)
      const verdict: Verdict =
        body.skill === "fall" ? fallVerdict(body.transcriptWindow)
        : body.skill === "food" ? await analyzeFood(body)
        : body.skill === "ask" ? await analyzeAsk(body)
        : body.skill === "calendar" ? calendarVerdict(body.query ?? "now", body.localNow)
        : body.skill === "route" ? await routeRequest(body)
        : await analyzeScam(body)
      // Events, not footage: only the verdict goes to the feed (never transcript or photo).
      if (verdict.needsCaregiver) verdict.eventId = publish(verdict, body.refines)
      // The calendar is polled every minute; only log it when it has something to say.
      if ((body.skill !== "calendar" || verdict.whisper) && body.skill !== "route")
        console.log(`[analyze] ${body.skill}${body.query ? `/${body.query}` : ""} -> ${verdict.severity} in ${Date.now() - t0} ms via ${verdict.source} (photo=${!!body.photoUrl})${body.skill === "calendar" ? ` "${verdict.whisper}"` : ""}`)
      if (body.skill === "route") console.log(`[route] "${body.transcriptWindow}" -> ${verdict.action}${verdict.whisper ? ` "${verdict.whisper}"` : ""} in ${Date.now() - t0} ms (${verdict.source})`)
      return json(verdict)
    }
    if (url.pathname.startsWith("/debug/")) {
      // Photos are sensitive: only the laptop itself may see them, never the public tunnel.
      if (!isLocalRequest(req)) return new Response("not found", {status: 404})
      const l = lastPhoto()
      if (url.pathname === "/debug/last") return json(l ? {at: l.at, skill: l.skill, note: l.note} : {})
      if (url.pathname === "/debug/photo" && l) return new Response(Buffer.from(l.data, "base64"), {headers: {"content-type": l.type, "cache-control": "no-store"}})
      return new Response("not found", {status: 404})
    }
    // Demo chat: the phone posts what the wearer said and what Grand Guard whispered. Held in memory only, and only
    // the laptop may read it (the public tunnel can post lines but never see them). CHAT_FEED=0 turns it off.
    if (url.pathname === "/chat" && req.method === "POST") {
      if (process.env.CHAT_FEED === "0") return json({ok: false})
      const b = (await req.json()) as {role?: string; text?: string}
      if ((b.role === "you" || b.role === "guard") && typeof b.text === "string" && b.text.trim()) {
        chat.push({id: ++chatId, at: Date.now(), role: b.role, text: b.text.trim().slice(0, 600)})
        if (chat.length > 300) chat.splice(0, chat.length - 300)
      }
      return json({ok: true})
    }
    if (url.pathname === "/chat" && req.method === "GET") {
      if (!isLocalRequest(req)) return new Response("not found", {status: 404})
      const since = Number(url.searchParams.get("since") ?? 0)
      return json(chat.filter((m) => m.id > since))
    }
    if (url.pathname === "/chat" && req.method === "DELETE") {
      if (!isLocalRequest(req)) return new Response("not found", {status: 404})
      chat.length = 0
      return json({ok: true})
    }
    if (url.pathname === "/profile" && req.method === "GET") return json({avoid: PROFILE.avoid, options: ALLERGEN_OPTIONS()})
    if (url.pathname === "/profile" && req.method === "PUT") {
      const b = (await req.json()) as {avoid?: unknown}
      if (!Array.isArray(b.avoid)) return json({error: "avoid must be a list"}, 400)
      return json({avoid: setAvoid(b.avoid), options: ALLERGEN_OPTIONS()})
    }
    if (url.pathname === "/calendar" && req.method === "GET") return json(listEvents())
    if (url.pathname === "/calendar" && req.method === "POST") {
      const by = url.searchParams.get("by") === "wearer" ? "wearer" : "caregiver"
      const r = addEvent((await req.json()) as never, by)
      return typeof r === "string" ? json({error: r}, 400) : json(r)
    }
    if (url.pathname.startsWith("/calendar/") && req.method === "DELETE") {
      return removeEvent(decodeURIComponent(url.pathname.slice("/calendar/".length))) ? json({ok: true}) : json({error: "not found"}, 404)
    }
    if (url.pathname === "/events" && req.method === "GET") return json(events)
    if (url.pathname === "/events/stream") {
      let ctrl!: ReadableStreamDefaultController<string>
      const stream = new ReadableStream<string>({
        start(c) {
          ctrl = c
          clients.add(c)
          c.enqueue(": connected\n\n")
        },
        cancel() {
          clients.delete(ctrl)
        },
      })
      return new Response(stream, {headers: {"content-type": "text/event-stream", "cache-control": "no-cache", ...cors}})
    }
    if (url.pathname === "/health") return json({ok: true})

    const file = Bun.file(`./caregiver${url.pathname === "/" ? "/index.html" : url.pathname}`)
    return (await file.exists()) ? new Response(file) : new Response("not found", {status: 404})
  },
})
console.log(`server on :${PORT} (LLM key ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING, heuristic mode"})`)
