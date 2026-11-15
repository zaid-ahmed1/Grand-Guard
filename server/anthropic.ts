/**
 * Extended thinking can use up the whole max_tokens budget and return no text, which made ambiguous
 * inputs fail JSON parsing and fall back to the keyword heuristic. Our calls want short JSON, so turn it off.
 * Haiku takes "disabled"; Sonnet takes "between_tools" (the API rejects "disabled" there).
 */
export const thinkingOff = (model: string) => (model.includes("haiku") ? {type: "disabled"} : {type: "between_tools"})

/**
 * Download a photo from the glasses' cloud storage. This hop crosses whatever network the laptop is on, and a single
 * 8 s attempt was failing on slow connections (the whole check then fell back to "unable to check"). Try up to
 * three times, 12 s each, and log how long it took so a slow network is visible in the server terminal.
 */
export async function downloadPhoto(url: string): Promise<{type: string; data: string}> {
  let last = ""
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = Date.now()
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(12_000)})
      if (!r.ok) throw new Error(`photo download ${r.status}`)
      const bytes = Buffer.from(await r.arrayBuffer())
      console.log(`[photo] downloaded ${Math.round(bytes.length / 1024)} KB in ${Date.now() - t} ms (try ${attempt})`)
      return {type: r.headers.get("content-type")?.split(";")[0] ?? "image/jpeg", data: bytes.toString("base64")}
    } catch (e) {
      last = (e as Error).message
      console.warn(`[photo] download try ${attempt} failed after ${Date.now() - t} ms: ${last}`)
    }
  }
  throw new Error(`photo download failed: ${last}`)
}
