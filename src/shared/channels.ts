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
  "engine:simNoise": Record<string, never>
  "engine:setNoise": {on: boolean}
  "engine:setPaused": {paused: boolean}

  // background → WebView
  "engine:backend": {url: string}
  "engine:voice": VoiceConfig
  "engine:wake": {phrase: string}
  "engine:noise": {on: boolean}
  "engine:paused": {paused: boolean}
  "pong": {at: number; roundtripMs: number}
  "p0:log": {at: number; msg: string}
  /** Loudness of the microphone in dB (0 is the loudest). Levels only, never audio. `status` carries a message instead. */
  "p0:level": {rmsDb: number; peakDb: number; roomDb: number; at: number; status?: string; calibrating?: number}
  "p0:transcript": {text: string; isFinal: boolean; source?: string; latencyMs: number}
  "p0:photoResult": {url: string; mimeType: string; bytes: number; latencyMs: number; size: string; compress: string}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
