/** Grand Guard backend: /analyze, /events (+SSE), static caregiver page. */
import {analyzeScam} from "./llm"
import type {AnalyzeRequest, CaregiverEvent, Verdict} from "../src/shared/types"

const PORT = Number(process.env.PORT ?? 8787)
const events: CaregiverEvent[] = []
const clients = new Set<ReadableStreamDefaultController<string>>()
const cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "content-type"}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {status, headers: {"content-type": "application/json", ...cors}})

function publish(v: Verdict) {
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
  for (const c of clients) {
    try {
      c.enqueue(`data: ${JSON.stringify(ev)}\n\n`)
    } catch {
      clients.delete(c)
    }
  }
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
      if (body.skill !== "scam") return json({error: `unknown skill ${body.skill}`}, 400)
      const verdict = await analyzeScam(body)
      // Events, not footage: only the verdict goes to the feed (never transcript or photo).
      if (verdict.needsCaregiver) publish(verdict)
      console.log(`[analyze] ${body.skill} -> ${verdict.severity} in ${Date.now() - t0} ms (photo=${!!body.photoUrl})`)
      return json(verdict)
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
