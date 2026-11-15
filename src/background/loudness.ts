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
/** For this long after the first audio arrives, only measure the room's average level; no noise can trigger anything. */
export const CALIBRATE_MS = 15_000
/** After a trigger, ignore noise for this long. */
export const REFRACTORY_MS = 60_000

export type Level = {rmsDb: number; peakDb: number; roomDb: number; loud: boolean; calibrating: boolean; secondsLeft: number}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-6))

export class LoudnessWatcher {
  /** The room's usual level (linear). Set from the 15 s calibration, then a slow moving average that does not chase loud events. */
  private room = 0.005
  private startedAt = 0
  private calRms: number[] = []
  /** True once the calibration window has finished. */
  calibrated = false
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

    // Calibration: the first 15 s just learn the room's average level. Nothing can trigger.
    if (!this.startedAt) this.startedAt = now
    if (!this.calibrated) {
      if (now - this.startedAt < CALIBRATE_MS) {
        this.calRms.push(rms)
        return {rmsDb: db(rms), peakDb, roomDb: db(median(this.calRms)), loud: false, calibrating: true, secondsLeft: Math.ceil((CALIBRATE_MS - (now - this.startedAt)) / 1000)}
      }
      // The middle value, not the mean, so a cough or a clap during calibration does not inflate the room level.
      if (this.calRms.length) this.room = Math.max(median(this.calRms), 0.0005)
      this.calRms = []
      this.calibrated = true
    }

    const loud = peakDb > PEAK_DB && rms > this.room * OVER_ROOM && now - this.lastHit > REFRACTORY_MS
    if (loud) this.lastHit = now
    else if (rms < this.room * 3) this.room = this.room * 0.98 + rms * 0.02
    return {rmsDb: db(rms), peakDb, roomDb: db(this.room), loud, calibrating: false, secondsLeft: 0}
  }
}
