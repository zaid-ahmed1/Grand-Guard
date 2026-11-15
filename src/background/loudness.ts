/**
 * Loud-noise trigger for the fall check-in. Measures volume only: each audio chunk is reduced to two numbers (average and
 * peak level) and thrown away. No audio is stored, transcribed here, or sent anywhere.
 *
 * A noise only starts the "Are you okay?" check-in; it never alerts anyone by itself. The thresholds are deliberately high
 * and the meter in the miniapp shows live levels so they can be tuned in the room where the demo is filmed.
 */

/** A hit needs the peak above this (dB relative to full scale; 0 is the loudest possible)... */
export const PEAK_DB = -8
/** ...and the average level at least this many times the room's usual level (a yell or a bang, not a louder conversation). */
export const OVER_ROOM = 10
/** After a trigger, ignore noise for this long. */
export const REFRACTORY_MS = 60_000

export type Level = {rmsDb: number; peakDb: number; roomDb: number; loud: boolean}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-6))

export class LoudnessWatcher {
  /** The room's usual level (linear), a slow moving average that does not chase loud events. */
  private room = 0.005
  private lastHit = 0
  chunks = 0
  /** Set when the audio is not plain 16-bit PCM, which this cannot measure (compressed audio would read as random noise). */
  unsupported: string | null = null

  /** Measure one chunk. Returns null when the format cannot be measured. */
  measure(b64: string, format: string | undefined, now = Date.now()): Level | null {
    this.chunks++
    if (!/pcm/i.test(format ?? "")) {
      this.unsupported = `audio format "${format ?? "unknown"}" is not plain PCM`
      return null
    }
    this.unsupported = null
    const bin = atob(b64)
    const n = bin.length >> 1
    if (n < 16) return null
    let sum = 0
    let peak = 0
    for (let i = 0; i < n; i++) {
      let v = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i)
      if (v >= 32768) v -= 65536
      const a = Math.abs(v) / 32768
      sum += a * a
      if (a > peak) peak = a
    }
    const rms = Math.sqrt(sum / n)
    const peakDb = db(peak)
    const loud = peakDb > PEAK_DB && rms > this.room * OVER_ROOM && now - this.lastHit > REFRACTORY_MS
    if (loud) this.lastHit = now
    else if (rms < this.room * 3) this.room = this.room * 0.98 + rms * 0.02
    return {rmsDb: db(rms), peakDb, roomDb: db(this.room), loud}
  }
}
