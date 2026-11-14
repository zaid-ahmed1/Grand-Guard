/** Grand Guard backend: /analyze, /events (+SSE), static caregiver page. */
import {analyzeScam} from "./llm"
import {analyzeFood} from "./food"
import {analyzeAsk} from "./ask"
import {addEvent, calendarVerdict, listEvents, removeEvent} from "./calendar"
import type {AnalyzeRequest, CaregiverEvent, Verdict} from "../src/shared/types"

const PORT = Number(process.env.PORT ?? 8787)
const events: CaregiverEvent[] = []
const clients = new Set<ReadableStreamDefaultController<string>>()
const cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS"}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {status, headers: {"content-type": "application/json", ...cors}})

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
      existing.whisper = v.whisper
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
    whisper: v.whisper,
    summary: v.caregiverSummary,
    evidence: v.evidence,
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
      if (!["scam", "food", "ask", "calendar"].includes(body.skill)) return json({error: `unknown skill ${body.skill}`}, 400)
      const verdict =
        body.skill === "food" ? await analyzeFood(body)
        : body.skill === "ask" ? await analyzeAsk(body)
        : body.skill === "calendar" ? calendarVerdict(body.query ?? "now", body.localNow)
        : await analyzeScam(body)
      // Events, not footage: only the verdict goes to the feed (never transcript or photo).
      if (verdict.needsCaregiver) verdict.eventId = publish(verdict, body.refines)
      console.log(`[analyze] ${body.skill} -> ${verdict.severity} in ${Date.now() - t0} ms via ${verdict.source} (photo=${!!body.photoUrl})`)
      return json(verdict)
    }
    if (url.pathname === "/calendar" && req.method === "GET") return json(listEvents())
    if (url.pathname === "/calendar" && req.method === "POST") {
      const r = addEvent((await req.json()) as never, "caregiver")
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
