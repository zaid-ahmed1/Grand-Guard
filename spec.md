# SPEC.md — Grand Guard (formerly "Guardian Glasses")

Elder-care assistant on **Mentra Live** camera glasses. Built at Immerse the Bay 2026 (Stanford, Nov 13–15).
Status: **v0.2 (Nov 14): the theme is now senior independence, with two modes (ambient and manual) and a calendar. See §2, §6.4–6.5 and the change log in §14.** Anything marked `VERIFY` is an unconfirmed assumption: test it before building on it.

---

## 0. How to work with this file (instructions for Claude Code)

- Read this whole file before writing code. Work **phase by phase** (Section 9). Do not start a later phase until the current phase's acceptance checks pass or we explicitly skip them.
- **Never guess Mentra SDK calls.** Add the docs MCP first and query it before writing any SDK code:
  `claude mcp add --transport http mentraos-docs https://docs.mentraglass.com/mcp`
  Also fetch https://docs.mentraglass.com/llms.txt for the page index. The SDK is in **beta** and APIs change.
- TypeScript + Bun. Secrets only in `.env` (never committed). Small commits. MIT license on everything (hackathon rule: public repo, MIT).
- When something in `VERIFY` fails, stop, report the exact error/measurement, and propose the fallback in this spec. Do not silently work around it.
- Prefer the simplest thing that demos reliably. This is a 36-hour hackathon; a polished 2-skill demo beats a flaky 4-skill one.
- Log liberally (the dev server forwards miniapp console logs to the terminal).

---

## 1. Goal, constraints, deadlines

**Goal:** win the **ManageXR "Bring AI to the Physical World w/ Smart Glasses"** sponsor track (judging: *glasses-native*, *AI that responds*, *experience*) plus a main track (**Virtuous Reality** = social good + XR, and/or **AI Horizons** = best use of AI with XR). Max 2 main tracks.

**Hard constraints (from ITB rules):**
- Submission on Devpost with a **30-second vertical demo video** + **public git repo**, all code **MIT**.
- **Pens down Sunday 9:00 AM PT.** Submissions are pulled exactly then; no submission = no judging table. Target: submitted by **8:00 AM Sunday**.
- Hardware must be public/sponsored: Mentra Live (loaned) is fine.
- LLMs/agentic coding allowed.

---

## 2. Product in one paragraph

**Theme: senior independence.** Older adults face many small, high-stakes moments that nobody can google, and many things they are too proud to ask for help with (small print, paperwork, a confusing device, what they are supposed to be doing right now). Grand Guard sees and hears what the wearer sees and hears and **whispers a short, calm answer in their ear**. Nobody else in the room knows it helped. Safety events (a scam, an allergen) go quietly to a caregiver as an **event, not footage**; everything else stays private to the wearer. One shared engine, several "skills", in two modes:

**Ambient mode** (audio only, always listening, no camera, speaks only when something is wrong or due): Scam Shield, calendar reminders.
**Manual mode** (the wearer asks; the camera is allowed and always announces itself): Food Check, Ask Grand Guard (read this, explain this, how do I use this, say that again), and calendar questions.

The modes are defined by what they use, not by the skill's topic. **The camera is never used without the wearer asking** (no ambient photo-taking), which is why Food Check is manual.

| Skill | Trigger | What it does |
|---|---|---|
| **Scam Shield** (HERO #1) | Scam-like phrases in live transcript, or voice command | Looks at the screen/letter + listens, whispers "this looks like a scam, don't pay", alerts caregiver |
| **Food Check** ("Is this safe for me?") (HERO #2) | Voice: "check this food" / "check this leftover" | Packaged food: barcode/label → allergens vs. wearer's profile, expiry date, (stretch) recalls. Leftovers: asks how old it is, warns if past guidance |
| **Ask Grand Guard** (manual) | Wearer's own wake word + a natural request ("read this", "what does this letter mean", "how do I use this remote", "say that again") | Photo when the request is about something visible; Claude answers in ≤ 35 words, plain language. Private by default (see 6.4) |
| **Calendar** (manual query + ambient reminders) | No wake word: "what am I supposed to be doing", "what's next", "what time is it"; plus a spoken reminder before an event | Answers from a caregiver-maintained schedule with plain code, never an LLM guess (see 6.5) |
| *(stretch, cut first)* Ask About This Pill | Voice: "check this bottle" | Reads the label and explains the directions in plain language; compares to the caregiver's schedule. No dose tracking claims (see 6.3) |
| *(stretch, cut first)* Fall check-in | IMU impact spike | Asks "are you okay?", listens, photo + alert caregiver if no answer |

**Scope decision (Sat 7:15 AM): we build Scam Shield and Food Check as the two hero skills and polish them. Everything else is a stretch and gets cut before either hero is compromised.**
**Update (Sat Nov 14): Ask Grand Guard and the Calendar are added as the independence layer. They reuse the same voice, photo, Claude and whisper path, so each is small. Cut rule unchanged: they are cut before either hero is compromised. Voice-added calendar events are an extension, not scope.**

**Users:** the *wearer* (older adult, voice-only interaction, chooses their own wake word) and the *caregiver* (web feed, settings and calendar).

---

## 3. Why this is legit and why glasses (for README / Devpost / judges)

Use only these figures; the cited source is in parentheses. Don't blend settings into one headline number.

- **Fraud:** people 60+ filed **201,266** complaints with the FBI in 2025, reporting **$7.75B** losses (+59%); tech/customer-support scams **$1.04B**; crypto ATM **$257.5M** (FBI IC3 2025). FBI notes underreporting.
- **Medication (only cite if the stretch skill ships):** adults 65+ made **34.5%** of ED visits for adverse drug events (CDC, JAMA 2016, 2013–14 data); medication errors were documented in only **10.5%** of those visits — *do not claim the whole figure is "mix-ups."* Why older adults mis-take meds: **forgetting is the leading cause** (38.8% in a Portuguese polymedicated-elderly study; 46.2% in a German neurogeriatric sample), and "not knowing whether I already took it" is the top challenge in a CHI 2025 study (Mahmood et al.). Glasses can't observe that, so we do **not** pitch dose tracking. One 2024 study found 95.6% of older adults could read labels but only 35% could interpret the directions → "Ask About This Pill" targets understanding, not forgetting.
- **Food safety:** nearly **half** of people 65+ with lab-confirmed Salmonella/Campylobacter/Listeria/E. coli infection are hospitalized (CDC).
- **Food allergy (be careful):** older-adult prevalence is uncertain — pooled self-report **12%** vs **0.5%** challenge-confirmed (single study) (World Allergy Organization Journal meta-analysis); one US estimate **8.8%** at 60+ (Gupta et al.). In older adults medications, not food, are a more common anaphylaxis trigger in at least one hospital study. Hence we frame Food Check as **"is this safe for me?"** (allergens + expiry + recalls), not "allergen scanner."
- **Falls (context only):** **41,400** deaths and >**3.85M** ED visits among adults 65+ in 2023 (CDC WISQARS via AARP/NSC).

**Why Mentra Live, not Quest 3** (research-backed; verify wording before quoting):
- Mentra Live **43 g**, camera/mic/speakers, no display. Quest 3 is **515 g**, up to ~2.2 h battery, and video passthrough replaces your view of the world (Pfeil et al., CHI 2021; Lee & Kim DiminishAR, CHI 2025).
- Older adults raise weight/comfort/donning concerns about AR headsets (Jin et al., CHI 2024).
- Snapshots beat streaming on smart glasses for heat/battery (Nicholas et al., CSCW 2022) → we use **checkpoint photos**, never continuous video.

**Why glasses, not just a phone app** (this is the most likely judge objection):
- In a real scam the phone is **the weapon** — the victim is on a call with the scammer; they can't also open an app.
- Glasses can **hear the call and see the laptop screen at once**; a phone on the table can't.
- Warnings are **whispered privately** — a speakerphone warning would be heard by the scammer.
- Hands-free and already pointed where the wearer looks (ATM, store aisle, pill bottle in hand).
- Honest caveat: Mentra Live still needs a phone for its companion app. We pitch the phone as the thing under attack, not as absent.

**Known weakness to state honestly:** audio-only guidance can raise mental demand vs. spatial visual guidance (Kim et al., IEEE VR 2026). Mitigation: very short, step-aware whispers (≤ 20 words), adjustable volume, and a judge-facing screen that shows what the AI saw.

---

## 4. Architecture

```
Mentra Live glasses ──BLE/Wi-Fi──► Phone (Mentra App)
                                      │ runs our miniapp
                                      │  ├─ background layer (QuickJS/JSC, always-on, holds `session`)
                                      │  └─ UI layer (React in WebView, only while tile is open)
                                      ▼ HTTPS (fetch)
                              Our backend (Bun/Hono or Express)
                                      ├─ LLM (Claude API, vision + text; model id from env)
                                      ├─ barcode decode + Open Food Facts lookup
                                      ├─ (optional) face blur before LLM
                                      ├─ event store (SQLite/JSON file) + SSE
                                      └─ Caregiver web app (static, served by backend)
```

Key facts from the docs (as of Nov 14, 2026):
- **Miniapp SDK (`@mentra/miniapp`)**: code runs **on the phone inside the Mentra App**, not in the cloud and not on the glasses. Glasses capture/play only.
- Background layer is a **bare JS engine** (no DOM, no Node, no canvas); `fetch`, `WebSocket`, `localStorage`, timers, `atob/btoa`, limited `crypto` exist. UI layer is a WebView with no hardware access; it talks to the background via messaging.
- APIs we expect to use (confirm exact signatures via the docs MCP): `session.camera.takePhoto({size, compress, transferMethod})` → returns `{photoUrl (signed, ~30 min TTL), mimeType, size, requestId}` (not raw bytes); transcription subscription with **`forceLocal: true`** (on-device STT, text only; default is cloud STT); `session.mic` (raw chunks, VAD); text-to-speech/speaker module; `session.imu` (`onHeadPosition` up/down transitions, `onAccel` raw {x,y,z} in g).
- Manifest `miniapp.json` must declare `CAMERA` and `MICROPHONE` permissions (and IMU requirement if used, mark OPTIONAL).
- **Design rule: the phone never handles image bytes.** Pass the signed `photoUrl` to our backend and let the backend download it. Never block a step on vision; vision results arrive asynchronously and are whispered when ready.
- Mentra's docs banner **recommends the Bluetooth SDK (`@mentra/bluetooth-sdk`) for Mentra Live** — a native/React Native app we would build that connects directly to the glasses and could do local face blur. That is our **fallback**, decided at the Phase 0 gate. Don't start it unless Phase 0 says we must.

**LED/privacy:** Mentra Live's recording LED is a hardware privacy feature. Do not try to defeat it. We reduce how often it lights by using on-demand/triggered photos instead of continuous video, and the glasses say "camera on" before capture.

---

## 5. The engine (shared by all skills)

Pipeline: **Trigger → Capture → Check → Whisper → Notify.**

```ts
type Severity = "info" | "warn" | "danger";

interface Verdict {
  skill: string;                 // "scam" | "food" | "meds" | ...
  severity: Severity;
  whisper: string;               // <= 20 words, plain language, spoken to the wearer
  caregiverSummary?: string;     // short text for the feed
  evidence?: { kind: string; detail: string }[]; // e.g. matched phrases, barcode, label text
  needsCaregiver: boolean;
}

interface Skill {
  id: string;
  triggers: Trigger[];           // keyword/phrase, voice command, imu
  needsPhoto: boolean;
  photoOptions?: { size: "low"|"medium"|"high"; compress: "none"|"low"|"medium"|"high" };
  analyze(ctx: { transcriptWindow: string; photoUrl?: string; profile: Profile }): Promise<Verdict>;
}
```

Engine responsibilities (miniapp background layer):
1. Keep a **rolling transcript window (~60 s)** in memory only (never persisted, never sent to caregiver verbatim).
2. Evaluate cheap triggers locally (keywords/phrases, voice commands). Only call the backend on a trigger. A backend LLM classifier on the window is allowed as a second-stage check, rate-limited.
3. On trigger: say "camera on" (TTS) → `takePhoto` (if skill needs it) → POST `{skill, transcriptWindow, photoUrl, profileVersion}` to backend → receive `Verdict` → whisper it → POST event to the feed.
4. Debounce: per-skill cooldown (e.g., 30 s) so we don't spam whispers.
5. Voice commands. There is no platform wake word, so the engine matches the transcript. Two kinds:
   - **Direct phrases, no wake word:** "check this food", "is this a scam?", and the calendar and clock questions ("what am I supposed to be doing", "what's next", "what time is it"). These are unlikely in normal conversation, and the person who most needs the calendar answer is the one most likely to forget a wake word.
   - **Wearer-chosen wake word** (default "grand guard", at least 4 letters), matched fuzzily because on-device STT mishears names. "<wake> <request>" or a bare "<wake>" (the glasses say "Listening." and wait 8 s). Claude-free routing sends the request to food, scam, calendar, "say that again" or the general Ask skill; "cancel" or "never mind" stops it.
   - The glasses **ignore transcripts while they are speaking** (and for ~1 s after) so their own whispers are never treated as commands or added to the scam window.
6. Always degrade gracefully: if photo or vision fails, whisper a safe fallback ("I couldn't read that, ask your caregiver") and log it.

---

## 6. Skills — detail

### 6.1 Scam Shield (hero)
- **Triggers:** phrases such as gift card, wire transfer, crypto/Bitcoin ATM, "don't tell anyone", IRS/Social Security/Medicare caller, "your computer has a virus", remote-access requests, urgency + secrecy combos; or voice command.
- **Photo (on trigger):** the screen, letter, or ATM in view.
- **Analysis (backend, Claude):** given transcript window + image, classify {scam / likely scam / unclear / safe}, cite the specific red flags, produce a whisper like *"This looks like a scam. Don't pay or give any codes. I'm telling your daughter."*
- **Notify:** caregiver event with severity and red flags (no transcript dump).
- **Audio limitation (important, `VERIFY`):** the glasses mics only hear the *other side* of a phone call if the call is on **speakerphone** (or the "scammer" is in the room / on a laptop video call). If the wearer holds the phone to their ear, we only hear the wearer. The demo uses speakerphone. Say this honestly if asked.
- **Scenarios to support (in priority order):** (1) tech-support pop-up on a laptop + a caller telling them to pay/give access; (2) a request for gift cards / crypto ATM / wire transfer; (3) "grandchild in trouble / don't tell anyone" call (audio-only is fine); (4) a letter or text claiming to be from IRS/Medicare/bank.
- **Escalation:** `info` = whisper only; `warn` = whisper + feed event; `danger` (multiple red flags such as urgency + secrecy + untraceable payment) = whisper + feed event with thumbnail (if allowed) + optional SMS.
- **Demo scene:** scammer on a speakerphone call (played by a teammate) + fake tech-support pop-up on a laptop; glasses whisper; caregiver phone buzzes. Include a "phone can't do this" beat (phone is busy on the call and can't see the laptop screen).

### 6.2 Food Check
- **Trigger:** voice "check this food".
- **Photo:** `size: "high"`, low compression (barcode needs detail). `VERIFY` focus distance and resolution at ~20 cm.
- **Pipeline (backend):** decode barcode (e.g., ZXing WASM/JS) → Open Food Facts lookup (`https://world.openfoodfacts.org/api/v2/product/<barcode>.json`; no API key; `VERIFY` fields: `allergens_tags`, `ingredients_text`) → compare to wearer profile (allergens, diet flags) → Claude vision reads the **"Contains/May contain" line and expiry date** from the same photo as a cross-check.
- **Data reality:** OFF is crowd-sourced and returns intermittent 503s. **Cache the demo products locally**, always cross-check with the label text, and never say "safe" without a caveat; say "I don't see milk in the ingredients, but check the label."
- **Whisper examples:** *"This contains milk. You avoid milk. Don't eat this."* / *"Expired 3 days ago."*
- **Stretch:** recall check (`VERIFY` openFDA food enforcement API availability).
- **Mode B — Leftover check (no barcode needed):** voice "check this leftover". Glasses ask "When did you make this?", listen to the answer, optionally look at the container/food, then compare against food-safety guidance (`VERIFY` thresholds against USDA FoodKeeper / FoodSafety.gov before hardcoding; store them as a small config table with the source noted). Whisper e.g. *"That's 5 days old. It's safer to throw it out."* This ties directly to the food-safety evidence (older adults hospitalized at high rates from foodborne illness) and works when OFF has no data.
- **Profile (set by caregiver, read-only to the wearer):** allergens to avoid, diet flags (e.g., avoids milk, low sodium preference), and "strictness" (warn on *contains* vs. also *may contain*). Never claim medical certainty; always add "check the label" language when relying on OFF data.
- **Failure paths to design for:** barcode not found in OFF → fall back to label-text vision ("Contains" line); barcode unreadable → ask the wearer to hold it closer/steady and retry once, then fall back to reading the front label; no network → say so and don't guess.

### 6.3 Ask About This Pill (STRETCH — cut first, only after both heroes are polished)
- **Why it's a stretch:** the leading cause of mis-taken meds is forgetting / not knowing whether a dose was taken, which glasses can't observe (and a dose taken before the glasses were on is invisible to us). So we do **not** build or pitch dose tracking or a "double-dose warning."
- **What it does instead:** voice "check this bottle" → photo of the label → Claude vision reads drug name, strength and directions → whisper the directions in plain language ("take one tablet in the morning with food") and, if the caregiver entered a schedule, say what it lists for this pill. Optionally ask "Have you taken this today?" and just record the wearer's answer as *their statement*.
- **Safety rules (non-negotiable):** never say "you haven't taken it" or "go ahead and take it" based on missing data; "no record" is not permission. No dosing advice, no diagnosing, no "it's safe." When unsure: "Check with your caregiver or pharmacist."
- Framed as a label reader, not a medical device.

### 6.4 Ask Grand Guard (manual, independence layer)
- **Purpose:** the things people hesitate to ask a person about: small print, paperwork, doctor-speak, a device they cannot work, a sentence they missed.
- **Trigger:** wearer's wake word + natural speech. Claude is not used for routing: keywords pick food / scam / calendar / "say that again" / general. General requests that mention something visible ("this", "read", "letter", "menu", "remote") take a high-resolution photo (announced first).
- **Answer:** Claude (Sonnet with a photo, Haiku without), ≤ 35 words, plain, respectful, never mentions age or ability. Reads the important parts (who, amount, date, what is asked), gives one step at a time for devices, says what to adjust if it cannot read the image, explains health text without diagnosing and points to the doctor or pharmacist.
- **"Say that again":** replays the last ~20 s from the local transcript. Nothing leaves the device.
- **Privacy (principle 8):** private by default. Nothing goes to the caregiver, unless the item looks like a scam (then a `warn` safety event).
- **Limits (state honestly):** single-turn (no "ok, what next?" follow-ups); whether a photo is taken is decided by keywords.

### 6.5 Calendar (manual query + ambient reminders)
- **Data:** events set by the caregiver on the caregiver page (title, time, optional date or daily/weekly repeat, place) and, as a later extension, by the wearer speaking ("remind me to call Sam at 3"). Each event records `setBy`. Stored on the server; the wearer's glasses only ever receive the answer.
- **Wearer questions (no wake word):** "what am I supposed to be doing", "where am I supposed to be", "what's next", "what's on my schedule", "what do I have today". "What time is it" / "what day is it" are answered on the phone from its clock.
- **Answers are built by plain code from the schedule and the phone's clock. Never by an LLM.** It must not invent a time or place. Calm and exact, no exclamation marks:
  - now: *"Right now, you have Bingo at the bingo hall. It started at 2 PM. Added by your family."*
  - soon: *"Bingo starts in 10 minutes, at the bingo hall."*
  - nothing now: *"Nothing is planned right now. Next is dinner at 5 PM."*
  - nothing left: *"Nothing else is planned today."*
  - overlap: name both.
- **Time zone:** the phone sends its local date and time; the server does no time-zone math.
- **Ambient reminders:** a whisper ~10 minutes before an event, once per event. It is held back while someone is speaking, while the glasses are talking, or while waiting for a request.
- **Failure path:** no network or server error → *"Unable to read the calendar right now. Please ask a family member."* Never guess.
- **Extension (not scope):** wearer adds events by voice; Claude parses to a structured event, the glasses read it back for a "yes" before saving, and it is marked "added by you" so nobody's schedule is quietly rewritten. Google Calendar via a secret iCal link (recurrence rules are the hard part).

### 6.6 Fall check-in (stretch, only if everything else works)
- `session.imu.onAccel`: detect free-fall dip → impact spike → stillness (`VERIFY` sample rate and background streaming; no gyro found). On suspected fall: TTS "Are you okay?", listen ~30 s; if no reply, take a photo and alert caregiver. Accept "I'm fine" to cancel (this is the false-positive control).

---

## 7. Caregiver web app

Served by the backend (single static page + SSE). No native app.
- **Feed:** time, skill, severity, whisper text, short summary. Photo thumbnail only for `danger` events and only if the wearer's setting allows it. Real-time via SSE.
- **Settings:** wearer profile (name, allergens, diet flags, strictness), escalation contact (name + phone), what's shared (toggles). (Medication schedule only if the stretch skill ships.) Currently the allergen list is hard-coded server-side (`server/profile.ts`) until this UI exists.
- **Calendar editor:** add and delete events (title, time, date or repeat, place). Shows who set each item.
- **Notifications:** on-screen alert for the demo; optional SMS (e.g., Twilio) if time permits (`VERIFY` credits/keys).
- **Wearer transparency:** "What I shared" log the wearer can ask the glasses to read aloud ("what did you send my daughter?").

---

## 8. Privacy & safety principles (also put in README/Devpost)

1. **Events, not footage.** Caregivers get summaries; photos are ephemeral by default (delete after analysis; thumbnail only on danger with consent).
2. **Transcripts stay ephemeral.** Rolling in-memory window; use `forceLocal` STT so audio doesn't leave the phone; only text goes to the LLM.
3. **No face recognition. Faces blurred before the LLM** if feasible. Honest claim levels: (a) faces blurred on-device before upload [only if Phase 0 test C passes or we use the Bluetooth SDK path]; (b) faces blurred server-side before the LLM [raw photo still reaches our server and possibly Mentra storage]; (c) no blur. State the level we actually reached — don't overclaim.
4. **Consent & law:** California is all-party consent for recording confidential conversations; we analyze transcripts on the fly and do not store audio. Camera announces itself ("camera on").
5. **Dignity:** framed as protection/independence, not decline (Caldeira et al., CHI 2022; Chang et al., CSCW 2025 on resistance to agent support). The wearer controls sharing.
6. **Not a medical device.** No diagnosis, no dosing advice, no "safe to eat" certainty.
7. Hearing: adjustable volume; short utterances; captions in the caregiver/judge view.
8. **Independence first: private by default.** Things people are too proud to ask for (reading, paperwork, devices, what they are supposed to be doing) are answered in the wearer's ear and are **not** reported to the caregiver. Only safety events (a scam, an allergen, expired food) reach the feed. The wearer chooses their own wake word. Calendar items show who set them.
9. **The camera is never used without the wearer asking**, and always announces itself first. No ambient or periodic photos.
10. **Never invent facts the wearer will act on** (times, places, allergens, dates). Those come from code or from text read off the label; when unsure, say so and tell them to check.

---

## 9. Plan (times are PT; deadline is Sun 9:00 AM — submit by 8:00)

### Phase 0 — Experiments + decision gate (Sat ~7:00–9:30)
Run in the existing `scam-shield` miniapp. Report measured results.
- **A. Transcription:** subscribe with `forceLocal: true`, download the local model if required; show live text in the UI. *Check:* works with phone screen locked? latency?
- **B. Photo:** button → `takePhoto({size:"low", compress:"medium"})`, time it, open `photoUrl`. Also `size:"high"` on a barcode and a pill label from ~20 cm. *Check:* latency, whether barcode digits/label text are readable.
- **C. Face detection in the UI WebView** (MediaPipe/face-api) on the photo.
- **D. TTS whisper:** speak a sentence through the glasses speaker; check volume/clarity.
- **Gate:** if A, B, D work → continue with miniapp. If B fails for barcode legibility → drop Food Check's barcode path and rely on label OCR via vision. If C fails → use server-side blur and claim level (b). If A or B are fundamentally broken in the miniapp → switch to the Bluetooth SDK starter kit (React Native/Expo).

### Phase 1 — Engine + backend + Scam Shield (to ~12:30)
- Backend scaffold, `/analyze` endpoint, Claude vision/text call, event store + SSE, minimal caregiver page.
- Engine in the miniapp: rolling transcript, triggers, cooldowns, TTS whisper, event POST.
- *Acceptance:* staged scam scene triggers a whisper within ~5 s of the trigger phrase and an event appears in the caregiver page.

### Phase 2 — Caregiver settings + Food Check (to ~17:00)
- Profile/settings UI, Food Check Mode A (barcode → OFF → vision cross-check, with fallbacks) and Mode B (leftover check), cached demo products.
- *Acceptance:* 3 demo products (one with the wearer's allergen, one expired, one fine) plus one leftover case give correct whispers, and each failure path (not in OFF, unreadable barcode, no network) behaves as specified.

### Phase 2b — Independence layer (Sat afternoon, time-boxed)
- Wearer-chosen wake word, Ask Grand Guard (done), Calendar: server store + caregiver editor, "what am I supposed to be doing", clock questions, 10-minute reminders.
- *Acceptance:* with two seeded events, "what am I supposed to be doing" gives the correct answer for now / soon / nothing / nothing-left; a reminder fires once; the calendar answer never contains a time or place that is not in the schedule.

### Phase 3 — Harden both heroes + polish (to ~21:00)
- Run each hero 20× in the staged scenes; log latency and failures; fix the top failure modes. Tune whisper wording (≤ 20 words), cooldowns, error fallbacks, volume. Caregiver feed polish (clean layout, readable on a phone, SSE reconnect).
- **Only if both heroes are solid:** Ask About This Pill (6.3) or fall check-in (6.6), time-boxed to 90 minutes. Otherwise skip.
- Freeze features at ~21:00.

### Phase 4 — Demo, video, submission (Sat night → Sun 8:00)
- Rehearse the staged scenes. Record the **30-second vertical** video. README, LICENSE (MIT), screenshots, Devpost text (use Section 3). Push public repo. Submit by 8:00 AM Sunday; leave the last hour as buffer.
- **Cut rule:** at ~21:00 Saturday, anything not working gets cut; do not carry broken features into the demo.

### 30-second video beats (draft)
1. **0–7 s:** older adult at a laptop with a fake "virus" pop-up, on a speakerphone call with a "technician"; glasses whisper "This is a scam. Don't pay or give any codes."
2. **7–12 s:** caregiver's phone buzzes with the event (no footage).
3. **12–19 s:** grocery item scanned: "Contains milk. You avoid milk. Don't eat this."
4. **19–25 s:** leftover container: "When did you make this?" … "That's 5 days old. Safer to throw it out."
5. **25–30 s:** one-line close: *"Everyday decisions that nobody can google in the moment, caught as they happen."* Show the AI's view on a second screen.

### Judging map
- **Glasses-native:** hands-free, voice-in/voice-out, camera+mic on the glasses, whisper privacy, phone-fails-at-this scene.
- **AI that responds:** live loop (trigger → see/hear → whisper) with latency shown.
- **Experience:** polished staged scenes, caregiver feed, clear privacy story.
- **Tracks:** ManageXR + Virtuous Reality (social good) and/or AI Horizons.

---

## 10. Repo layout (proposed)

```
/                      README.md, SPEC.md, LICENSE (MIT)
/miniapp               Mentra miniapp (existing scaffold: bunx create-mentra-miniapp)
  miniapp.json         permissions: CAMERA, MICROPHONE (+ IMU optional)
  src/background       engine, triggers, skills glue, TTS, event POST
  src/ui               React UI (debug panel, face-detect experiment)
/server                Bun backend: /analyze, /events (SSE), /settings, barcode, OFF, LLM
/caregiver             static caregiver web app (served by /server)
/docs                  evidence table, privacy statement, demo script
```

## 11. Dev loop notes (Windows, current setup)

- Run `bun dev` in `/miniapp`. On this network the CLI printed a **Tailscale `169.254.x.x`** address in the QR. Workaround that worked: disable/ignore the Tailscale adapter and generate the QR yourself with the correct LAN IP:
  `bunx qrcode-terminal "miniapp://dev?url=http%3A%2F%2F<LAN-IP>%3A3001&name=My%20Miniapp&package=com.mentra.scam-shield&dev=3002"`
  Then scan it in Mentra App → Settings → Miniapp Developer Settings → Scan Miniapp QR Code. Phone and laptop must share a network (campus Wi-Fi may isolate clients; use a hotspot if it does).
- Android USB option: install adb (`winget install Google.PlatformTools`), enable USB debugging, `bun dev --usb`.
- Glasses firmware/SDK versions must match if we fall back to the Bluetooth SDK (latest matching pair noted in docs as 3.4.0).

## 12. Non-goals

Face recognition; ambient or periodic photo-taking (the camera only runs when asked); continuous video recording; reporting private "independence" requests to caregivers; diagnosing or dosing advice; medication dose tracking or "double-dose" warnings; HIPAA compliance; a native caregiver app; distribution via the Mentra store (not supported for miniapps right now).

## 13. Open questions (answer by end of Phase 0)

1. `takePhoto` latency and legibility (barcode, small label text).
2. Does local STT work in the background with the screen locked, and how fast?
3. Can the background layer or UI WebView run a face detector? (Else server-side blur.)
4. Exact TTS/speaker API and whether whispers can be quiet enough.
5. Does the miniapp stay alive when the phone is locked / app backgrounded?
6. ~~Wake word availability vs. transcription matching.~~ Answered: no platform wake word is used; we match the transcript (direct phrases plus a wearer-chosen, fuzzily matched wake word). Still open: whether the glasses' button or touch events reach the miniapp (`session.input.onButtonPress` / `onTouch` exist in the SDK) as a no-words trigger.
7. Which LLM model id and latency budget for the Claude calls (target < 3 s for text, < 6 s with image).
8. Who owns what among teammates (engine / backend / caregiver UI / Devpost+video)?
## 14. Change log

**v0.2 (Sat Nov 14)**
- Theme changed to senior independence. Two modes defined (ambient = audio only; manual = wearer asks, camera allowed). Food Check is manual.
- Added Ask Grand Guard (6.4), Calendar (6.5), wearer-chosen wake word (5.5), principles 8–10, Phase 2b.
- Built so far: local STT, photo and TTS (Phase 0 passed); Scam Shield with a loose keyword net and Claude deciding; Food Check (Claude reads the label verbatim, plain code judges allergens against `server/profile.ts` and the date); wake word + Ask Grand Guard; voice and speed controls.
- Deviations from v0.1: the miniapp lives at the repo root (`src/`, `miniapp.json`), not `/miniapp`; `processing: "localOnly"` replaces the deprecated `forceLocal`; SDK is 3.4.0. Food Check is vision-only for now (barcode and Open Food Facts are not built). The server is exposed through a Cloudflare quick tunnel with no auth yet. Add a shared-secret header before any public demo.
- Demo idea: add a 5-second calendar beat ("what am I supposed to be doing?" → "Right now, you have bingo at the bingo hall.") to show independence, not just protection.
