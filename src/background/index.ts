/**
 * Background entry. PHASE 0: experiment harness (spec §9) for
 *  A. local transcription, B. photo latency/legibility, D. TTS whisper.
 * Driven from the debug panel in the UI layer. Replaced by the real engine in Phase 1.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import type {Channels} from "../shared/channels"
import "../shared/channels"

registerMiniapp<Channels>(async (session) => {
  const log = (msg: string) => {
    console.log(`[p0] ${msg}`)
    session.ui.send("p0:log", {at: Date.now(), msg})
  }

  log(`capabilities: ${JSON.stringify(session.capabilities ?? {})}`)

  // --- A. transcription (on-device only; replaces deprecated forceLocal) ---
  let offStt: (() => void) | null = null
  let offModel: (() => void) | null = null
  let lastEventAt = Date.now()

  session.ui.on("p0:stt", ({on}) => {
    if (on && !offStt) {
      lastEventAt = Date.now()
      offModel = session.transcription.onModelStatus((s) =>
        log(`stt model: ${s.state}${s.progress != null ? ` ${s.progress}%` : ""}${s.reason ? ` (${s.reason})` : ""}`),
      )
      offStt = session.transcription.on(
        (d) => {
          const now = Date.now()
          session.ui.send("p0:transcript", {
            text: d.text,
            isFinal: d.isFinal,
            source: d.source,
            latencyMs: now - lastEventAt,
          })
          lastEventAt = now
        },
        {processing: "localOnly"},
      )
      log("stt started (localOnly)")
    } else if (!on) {
      offStt?.()
      offModel?.()
      offStt = offModel = null
      log("stt stopped")
    }
  })

  // --- B. photo ---
  session.ui.on("p0:photo", async ({size, compress}) => {
    if (!session.capabilities?.hasCamera) log("warning: capabilities.hasCamera is falsy")
    const t0 = Date.now()
    try {
      const p = await session.camera.takePhoto({size, compress, sound: false})
      const latencyMs = Date.now() - t0
      log(`photo ok ${size}/${compress}: ${p.size} bytes in ${latencyMs} ms`)
      session.ui.send("p0:photoResult", {
        url: p.photoUrl,
        mimeType: p.mimeType,
        bytes: p.size,
        latencyMs,
        size,
        compress,
      })
    } catch (e) {
      const err = e as {code?: string; message?: string}
      log(`photo FAILED after ${Date.now() - t0} ms: ${err.code} ${err.message}`)
    }
  })

  // --- D. TTS ---
  session.speaker.onStateChange((e) =>
    log(`speaker state -> ${e.state}${e.errorCode ? ` ${e.errorCode}: ${e.errorMessage}` : ""}${e.durationMs != null ? ` (${e.durationMs} ms)` : ""}`),
  )
  session.ui.on("p0:speak", async ({text, processing}) => {
    const t0 = Date.now()
    log(`speak start (processing=${processing}, state=${session.speaker.state})`)
    try {
      const r = await session.speaker.speak(text, {processing, volume: 1.0})
      log(`speak resolved in ${Date.now() - t0} ms (completed=${r.completed})`)
    } catch (e) {
      const err = e as {code?: string; message?: string}
      log(`speak FAILED after ${Date.now() - t0} ms: ${err.code} ${err.message}`)
    }
  })

  session.ui.on("ping", ({at}) => {
    session.ui.send("pong", {at: Date.now(), roundtripMs: Date.now() - at})
  })
  session.ui.onOpen(() => log("ui opened"))
})
