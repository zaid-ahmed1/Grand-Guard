/** Typed channel registry between background JSContext and UI WebView. */

export type Processing = "preferCloud" | "preferLocal" | "localOnly"
export type PhotoSize = "low" | "medium" | "high" | "max"
export type PhotoCompress = "none" | "low" | "medium" | "high"

export interface Channels {
  // WebView → background
  "ping": {at: number}
  "engine:setBackend": {url: string}
  "engine:simulate": {text: string}
  "p0:photo": {size: PhotoSize; compress: PhotoCompress}
  "p0:speak": {text: string; processing: Processing; speed: number}
  "engine:setVoice": {processing: Processing; speed: number}

  // background → WebView
  "engine:backend": {url: string}
  "engine:voice": {processing: Processing; speed: number}
  "pong": {at: number; roundtripMs: number}
  "p0:log": {at: number; msg: string}
  "p0:transcript": {text: string; isFinal: boolean; source?: string; latencyMs: number}
  "p0:photoResult": {url: string; mimeType: string; bytes: number; latencyMs: number; size: string; compress: string}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
