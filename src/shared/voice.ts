import type {Processing} from "./channels"

export interface VoiceConfig {
  processing: Processing
  /** Speech rate multiplier, passed to the provider as voice_settings.speed. */
  speed: number
  /** Optional provider voice id. Empty = provider default. */
  voiceId: string
  /** Flatter, less expressive delivery (voice_settings stability up, style 0). Provider-specific. */
  calm: boolean
}

export const DEFAULT_VOICE: VoiceConfig = {processing: "preferLocal", speed: 0.85, voiceId: "", calm: false}

/** SpeakOptions for a voice config. */
export function speakOptions(v: VoiceConfig) {
  return {
    processing: v.processing,
    ...(v.voiceId ? {voice_id: v.voiceId} : {}),
    voice_settings: {speed: v.speed, ...(v.calm ? {stability: 0.9, style: 0} : {})},
  }
}
