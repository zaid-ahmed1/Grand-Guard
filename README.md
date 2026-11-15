# Ally

An elder-care assistant for **Mentra Live** camera glasses. It sees and hears what the wearer sees and hears, **whispers a short warning in their ear at the moment of risk**, and quietly sends an **event (not footage)** to a caregiver.

Built at Immerse the Bay 2026 (Stanford, Nov 13-15). Sponsor track: ManageXR "Bring AI to the Physical World w/ Smart Glasses".

> Status: work in progress. See [`spec.md`](./spec.md) for the full plan and phase checklist.

## Skills

| Skill | Trigger | What it does |
|---|---|---|
| **Scam Shield** | Scam-like phrases in the live transcript, or "is this a scam?" | Listens and looks at the screen or letter, whispers a warning, alerts the caregiver |
| **Food Check** | "check this food" / "check this leftover" | Barcode/label vs. the wearer's allergen profile, expiry date, leftover age guidance |

## Why glasses, not a phone app

- In a real scam the phone is the weapon: the victim is on a call with the scammer.
- Glasses can hear the call and see the laptop screen at the same time.
- Warnings are whispered privately, so a speakerphone caller doesn't hear them.
- Hands-free, and already pointed where the wearer is looking.

Honest caveat: Mentra Live still needs a phone for its companion app, and the glasses mics only hear the other side of a call if it is on speakerphone.

## Privacy and safety

1. **Events, not footage.** Caregivers get summaries. Photos are used for analysis and not kept by default.
2. **Transcripts are ephemeral.** A rolling in-memory window; on-device speech-to-text so audio stays on the phone; only text goes to the LLM.
3. **No face recognition.** We state the face-blur level we actually reach, and don't overclaim.
4. **The camera announces itself** ("camera on") and we never try to defeat the hardware recording LED. Photos are taken on demand, never continuous video.
5. **Not a medical device.** No diagnosis, no dosing advice, no "safe to eat" certainty.

## Architecture

```
Mentra Live ──BLE──► Phone (Mentra App) runs our miniapp
                       ├─ background layer: engine (transcript, triggers, camera, whisper)
                       └─ UI layer: React debug panel
                              │ HTTPS
                              ▼
                       Backend (Bun): /analyze → Claude, /events (SSE), caregiver web page
```

## Repo layout

```
src/background   miniapp engine
src/ui           React UI (debug panel)
src/shared       typed channels and shared types
server/          Bun backend (Phase 1)
caregiver/       static caregiver web app served by the backend (Phase 1)
spec.md          project spec
```

## Running it

Requires [Bun](https://bun.sh), the Mentra App on your phone, and Mentra Live glasses.

```bash
bun install
cp .env.example .env     # fill in your keys
bun dev                  # miniapp dev server; scan the QR in Mentra App > Settings > Miniapp Developer Settings
bun run server           # backend (Phase 1)
```

The phone and laptop must be on the same network. If the QR shows a `169.254.x.x` address (e.g. Tailscale adapter), see "Dev loop notes" in `spec.md`.

## License

[MIT](./LICENSE)
