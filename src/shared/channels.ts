import type {VoiceConfig} from "./voice"
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
  "p0:speak": {text: string; voice: VoiceConfig}
  "engine:setVoice": VoiceConfig
  "engine:setWake": {phrase: string}
  "engine:simFall": Record<string, never>

  // background → WebView
  "engine:backend": {url: string}
  "engine:voice": VoiceConfig
  "engine:wake": {phrase: string}
  "pong": {at: number; roundtripMs: number}
  "p0:log": {at: number; msg: string}
  /** Accelerometer reading in g (about 10 per second for the chart). `peak` is the largest magnitude since the last one. */
  "p0:accel": {x: number; y: number; z: number; m: number; peak: number; at: number; simulated: boolean}
  /** What the glasses report about the motion sensor, for the Fall sensor panel. */
  "p0:imu": {status: string; head?: string}
  "p0:transcript": {text: string; isFinal: boolean; source?: string; latencyMs: number}
  "p0:photoResult": {url: string; mimeType: string; bytes: number; latencyMs: number; size: string; compress: string}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
