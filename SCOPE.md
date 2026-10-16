# Talking Cards — scope

An Obsidian plugin: RemNote-style flashcards written inline in normal notes, reviewed
with FSRS spaced repetition, and **read aloud** with text-to-speech. One plugin, no
dependencies on other plugins. Works on desktop and mobile (Android first).


---

## 1. Decisions locked

| Area | Decision |
|---|---|
| Platform | Obsidian community plugin, `isDesktopOnly: false`. No Node/Electron APIs anywhere. |
| Dependencies | Self-contained. No other plugin required. npm libs bundled in. |
| Card source | Whole vault. Decks = folder tree. Ignore-list in settings. |
| Card syntax | Compatible with the existing *Spaced Repetition* plugin (see §3) so existing cards just work. |
| Scheduler | FSRS via `ts-fsrs`. |
| Card identity | Tiny block ID appended to each card (`^tc-a1b2c3`). Native Obsidian, survives edits/moves. |
| Review data | Not in notes. Append-only review log per device, stored as **`.md`** (Sync's "other types" is off); card state derived by replaying it (see §5). |
| Sync | Obsidian Sync. Data layout designed so two devices never write the same file. |
| Default voice | Desktop: OS voice (Web Speech). **Android: the phone's default TTS via the Reader app's voice bridge** (§6) — a plugin can't reach it directly (§2). |
| Built-in engine | Piper voices via **onnxruntime-web + piper-phonemize** (WASM) in a Web Worker. Voices from rhasspy/piper-voices (fp32), espeak data per language (~0.8 MB), engine wasm checksum-verified; all in IndexedDB, per device. (sherpa-onnx's web build was rejected: 31 MB of engine and voices baked into its data file.) |
| Entry point | Ribbon (side panel) button → Dashboard tab. Plus commands + status-bar due count. |
| UI tech | Plain TypeScript + Obsidian DOM helpers, hand-drawn SVG charts. No React/chart libs. |
| Build | Official Obsidian sample-plugin setup (TypeScript + esbuild). Nothing extra. |

## 2. Findings from device tests

| Test | Result |
|---|---|
Tested 2026-10-14 on a mid-range Android phone (Android 16, Obsidian 1.14.4, WebView 154, a real vault via Obsidian Sync).

| Test | Result |
|---|---|
| Desktop (Linux, Flatpak Obsidian 1.14.4) `speechSynthesis.getVoices()` | **0 voices.** Sandbox can't reach speech-dispatcher; host only has espeak-ng anyway. Windows/macOS will have system voices. |
| Android — `speechSynthesis` in Obsidian | **Does not exist.** Android WebView has no Web Speech API, and none of Obsidian's built-in Capacitor plugins (App, Device, Filesystem, Haptics, KeepAwake, …) do TTS. **A plugin cannot reach the phone's Google/Samsung voice.** |
| Android — WASM, IndexedDB, AudioContext, CDN fetch | All available. No SharedArrayBuffer (single-threaded WASM only). 4 GB RAM, 8 cores. |
| Android — Piper via `vits-web` (en_GB alba medium, ~60 MB) | Downloads in ~15 s, runs, plays. But **~16 s per sentence regardless of voice size** → fixed overhead from that library rebuilding its pipeline each call, not inference. Needs a persistent session (M0). |
| Reference: native sherpa-onnx Piper fp32 on the same phone (Reader app) | RTF ≈ 0.2 with 2 threads. WASM single-thread should be several × slower but still usable for short cards. |
| Android — speech with screen locked | _Not tested._ Likely paused when Obsidian is backgrounded; audio mode assumes screen on. |
| Desktop (Node, 1 thread): built-in engine, alba medium | Model load 1.6 s, then **RTF 0.21**. Whisper transcribed the output word for word. |
| Chromium (browser pane): full install → speak → cache | Works. First speech 4.5 s (worker boot + model load); 2 s line in 0.46 s; repeat from cache 1 ms. |
| Android: built-in engine in the plugin | _To test when the phone is next connected._ Expect RTF ≈ 1 (single-thread WASM); look-ahead hides it. |

## 3. Card syntax

Plain Markdown, readable without the plugin.

| Type | Syntax | Cards made |
|---|---|---|
| Basic | `Question :: Answer` | 1 (Q→A) |
| Reversible | `Term ::: Definition` | 2 (both ways), siblings |
| Multi-line | question lines, `?` on its own line, answer lines | 1 |
| Multi-line reversible | same with `??` | 2 |
| Cloze | `The ==mitochondria== is the powerhouse` | 1 per highlight |
| Grouped cloze | `{{c1::a}} … {{c2::b}}` (Anki style) | 1 per group number |
| List answer (RemNote-ish) | `Question >>>` then a bullet list | 1, answer = list |

Rules:
- Ignored inside code blocks, frontmatter, and `%% comments %%`.
- Frontmatter `cards: false` skips a note; `deck: Some/Deck` overrides its folder deck.
- **Context breadcrumb** (RemNote's best feature): the review screen shows
  `Note title › Heading › Subheading` above the question.
- Card ID goes at the end of the card's last line: `Mitosis :: cell division ^tc-a1b2c3`.
  Cloze siblings share one ID + index (`^tc-a1b2c3` → `a1b2c3#1`, `#2`).
- Pronunciation override for TTS: `%%say: ...%%` on the card line.

## 4. Scheduling (FSRS)

- `ts-fsrs`, ratings **Again / Hard / Good / Easy** with next-interval shown on each button.
- Settings: desired retention (default 0.90), max interval, learning/relearning steps, fuzz.
- Daily limits: new cards/day, reviews/day (global in v1, per-deck in v2).
- Bury siblings (reverse + cloze siblings don't appear the same day).
- New card order: note order or random. Review order: due date, random, or by deck.
- Leeches: lapses ≥ 8 (configurable) → flagged + optionally auto-suspend.
- Suspend / bury / reset / reschedule per card.
- **Cram / custom study**: review a note, folder or search result ignoring due dates;
  doesn't touch the schedule unless toggled.
- v2: FSRS parameter optimiser from your own review history.

## 5. Data storage

```
<vault>/<data folder>/            (default: "Talking Cards", configurable)
  reviews-<deviceId>-<year>.md    append-only log of reviews AND actions (suspend/bury/reset),
                                  ONE file per device per year (keeps files small)
.obsidian/plugins/talking-cards/
  data.json                       settings only
IndexedDB (per device, not synced)
  piper voice models, TTS audio cache, derived card-state cache
```

Why per-device logs: Obsidian Sync resolves conflicts on non-Markdown files by "last
write wins". If phone and laptop both reviewed offline, one session would vanish.
With one log per device nothing ever conflicts; state = replay all logs in time order.

Why not inside `.obsidian/plugins/…`: Obsidian Sync only syncs the standard plugin
files (main.js, manifest, styles, data.json) — not extra files there.
Sync's "Sync all other types" is **off** (some vaults hold large non-note files), so data files
are `.md`: one JSON object per line inside a fenced ```` ```talking-cards ```` block, so the
note renders as a tidy code block and Sync always carries it. Settings recommend adding the
data folder to Obsidian's *Excluded files* so logs stay out of search and graph.

A card's history is never deleted; a card that disappears and comes back with the same
text (or ID) picks its progress up again.

### Edit tracking (`src/links.ts`, `src/edit-tracker.ts`)

Without written IDs, a card's ID is a hash of its text, so an edit gives it a new ID. When a
note changes, reviewed cards that vanished are paired with cards that appeared in the same
note (same question → same card; same answer → same card; otherwise character-pair
similarity ≥ 0.6, ties by position). Each pair is logged as `{"a":"link","k":new,"from":old}`;
linked IDs are one card (union-find, smallest ID as root, so every device agrees).
A vanished card stays matchable for 5 minutes (retyping an answer from scratch). Edits made
while Obsidian was closed are caught at startup against `edit-snapshot.json` (plugin folder,
per device). Unmatched reviewed cards are listed for Browse → "Take progress from…".
Setting: *When a card's text changes: Keep progress / Start over*. Written IDs remain an option.

## 6. Text-to-speech

Engine interface, every engine implements:
`listVoices() · speak(text, voice, rate, pitch) · stop() · isAvailable()`

| Engine | Where | Notes |
|---|---|---|
| **System** (Web Speech API) | desktop default where voices exist | Windows → SAPI, macOS → system voices. Not available on Android or Flatpak Linux. |
| **Built-in neural** (Piper: onnxruntime-web + piper-phonemize) | default on Android and Linux; optional everywhere | Engine ships in main.js (gzipped, ~3 MB); ~60 MB per voice + <1 MB language data, downloaded once per device into IndexedDB. Single-threaded WASM in a worker. |

Lessons carried over from the Reader app and an earlier read-aloud script:
- **Use fp32 Piper models, never int8** — int8 adds audible hiss (Reader issue #1). ~67 MB/voice.
- Don't recommend `low` / `x_low` voices — noticeably worse after resampling.
- Lower `noiseScale` (~0.3–0.5) if voices sound rough; apply speed via `length_scale`.
- **Kokoro isn't viable on a mid-range phone** (too slow even natively). Desktop-only option, maybe later.
- Voice store UX like Reader: grouped Recommended / Light & fast / Best quality, by language,
  speed-tested on the device after download and labelled.
- Markdown → speech cleanup: **port the earlier script's Markdown cleanup** (wikilink
  aliases, tables, callouts, code skipped, tags/URLs dropped — already tuned on 200 real notes).

### Android default voice: Reader voice bridge

A plugin can't call Android TTS, but the Reader app already wraps it
(`SystemTtsEngine.kt`) and runs Piper natively (`NeuralTtsEngine.kt`, RTF ≈ 0.2).
Add a **voice server** to Reader:

- Toggle in Reader settings: "Let other apps use my voices". Runs a small HTTP server on
  `127.0.0.1:<port>` inside a foreground service (notification) so Android doesn't kill it
  while Obsidian is in front.
- `GET /voices` → engines, languages, voices (system + Reader's downloaded neural ones).
- `POST /synthesize {text, voice, speed}` → WAV (`TextToSpeech.synthesizeToFile` for system
  voices, sherpa for neural). Returns audio rather than speaking, so the plugin plays and
  caches it the same way as every other engine.
- CORS header for Obsidian's `http://localhost` origin; a random token shown in Reader and
  pasted once into the plugin, so other apps on the phone can't use it.

Plugin side: a "Phone voice (Reader)" engine. On Android it's the default when Reader
answers; if it doesn't, the plugin falls back to the built-in engine and says why.
This is a soft dependency on an *app*, not a plugin — everything still works without it.

**Pre-render, don't speak live.** Unlike a book, the cards in a session are known up front.
When a review starts, synthesise the next few cards' front + back in the background and keep
a look-ahead queue, so even a slow WASM voice has audio ready before you need it. Audio is
cached in IndexedDB by hash(text + voice + speed), so tomorrow's repeats are instant.

Voice settings:
- Voice picker grouped by engine and language, with a ▶ test button.
- Separate voice for **front** and **back** (e.g. English question, Spanish answer).
- Rate and pitch sliders.
- Per-note override in frontmatter: `tts-front: es-ES`, `tts-back: en-GB`.
- Auto-read front on show / auto-read back on reveal (toggles).

Text cleanup before speaking: strip Markdown syntax, wikilink brackets (keep the
display text), block IDs, tags, HTML; images → alt text or nothing; LaTeX → skipped
("formula") in v1; cloze gap → "blank".

Neural audio cached by hash(text + voice) so each card is synthesised once.

## 7. UI

### Ribbon button → Dashboard (main-area tab)
- **Today strip:** Due · New · Learning · Reviewed today · Streak · 30-day retention.
- **Big "Study now"** button.
- **Deck tree** (folders), each row: New / Learn / Due counts + Study + ⋯ (cram, browse, deck settings).
- **Heatmap:** reviews per day, last 12 months.
- **Forecast:** due cards next 30 days (bar chart).
- **Notes with cards:** list per deck, card count, due count, click → open note.
- Tabs at top: **Overview · Browse · Stats**.

### Browse (card browser)
Table: front, back, note, deck, state, due, interval, stability, difficulty, reps,
lapses. Search + filters (deck, state, due, leeches, suspended). Row actions: open in
note, suspend, bury, reset, reschedule. Multi-select for bulk actions.

### Stats
Reviews per day, time spent per day, card count by state, interval histogram,
difficulty histogram, true retention by month. Filterable by deck.

### Review screen
- Breadcrumb context · progress (e.g. `12 / 40`) · deck name.
- Front → **Show answer** (Space) → back + four grade buttons with intervals (1–4 keys).
- 🔊 on each side, auto-read toggle, 🎧 audio-mode toggle.
- Undo last grade (Ctrl+Z / button), edit card (jumps to source line), suspend, bury.
- Mobile: buttons pinned to bottom, large tap targets, works one-handed.

### Swipe to grade
Once the answer shows: ↑ Good · → Easy · ↓ Again · ← Hard (each direction configurable, or off).
The screen tints the grade's colour and a large label names it while dragging; release past the
threshold flings the card and grades. Dragging the question does nothing; tap reveals.
Haptic tick when armed. Long cards that scroll keep only horizontal swipes.

### Customisation (Settings → Talking Cards)
Swipe: on/off, mapping, distance, legend, haptics · Review screen: text size, alignment, tap to
reveal, keep question visible, context, progress bar, 4 or 2 grade buttons, intervals, tool row,
read-aloud buttons, key hints, reduce motion · Session: cards per session, new cards mixed/first/
last, note order/random · plus daily limits, FSRS, leeches, voices, audio mode, card syntax.

### Audio mode (hands-free-ish)
Read front → wait (configurable seconds, or tap) → read back → wait for grade.
Grade with four giant full-screen tap zones. Optional "auto-Good after N s"
for genuinely hands-free listening (off by default — it corrupts the schedule if you
weren't listening).

### Elsewhere
- Status bar: `🗂 23 due` (click → dashboard).
- Commands: open dashboard · study all · study current note · study current deck ·
  cram current note · browse cards of current note · insert card ID.
- Editor: gutter/inline marker showing a card's due date (v2).

### Settings tab
Card source (ignore folders, data folder) · syntax toggles · FSRS options · daily
limits · review order · TTS (engine, voices, rate, pitch, auto-read, audio-mode
timings, download/remove offline voices) · leech threshold.

## 8. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | **Spikes** | sherpa-onnx WASM loads inside an Obsidian plugin (bundled, no CDN), keeps a session, and a typical card synthesises on a mid-range phone faster than it plays (RTF < 1). Screen-lock behaviour checked. |
| M1 | Parser + IDs ✅ | All §3 syntax parsed with unit tests; IDs added without mangling notes. |
| M2 | Store + FSRS + review screen ✅ | Can study a deck on desktop; logs replay correctly; undo works. |
| M3 | Dashboard ✅ | Ribbon button, deck tree, today strip, status bar, commands. |
| M4 | System TTS + audio mode ✅ | Desktop Web Speech, voice picker, front/back voices, auto-read, audio mode (think-time countdown, tap-anywhere reveal, 2×2 grade zones, optional auto-Good, keep screen on). Headphone-button control: v2. |
| M5 | Built-in neural TTS ✅ | Engine in worker, voice store, download/caching, look-ahead pre-render, 🔊 buttons, auto-read. Phone speed still to measure. |
| M5b | Reader voice bridge ✅ (built, not on phone yet) | Reader 0.5.0 on branch `voice-bridge`: token-protected server on 127.0.0.1:51515, JVM-tested. Plugin: Reader engine (requestUrl), phone voices automatic on Android, language overrides, shared cache; tested against `test/harness/fake-reader.mjs`. |
| M6 | Browse + Stats ✅ | Dashboard tabs. Browse: search, deck/state filters (due, leeches…), sortable columns, bulk suspend/unsuspend/reset, open in note. Stats: retention, heatmap, 30-day forecast, reviews/day, states, intervals, difficulty; deck filter; tooltips + table views. Leech flag/auto-suspend. |
| M7 | Mobile polish + release | Tested on phone via Sync; README; optional community-store submission. |

v2 backlog: per-deck limits/settings, FSRS optimiser, voice grading (say "good"),
image occlusion, Anki `.apkg` import/export, migrate from Spaced Repetition plugin's
inline `<!--SR:…-->` data, editor due-date markers, LaTeX spoken as words.

## 9. Dev setup

- Test vault: `test-vault/` with sample cards — **never develop against a real vault.**
- Build output copied into the test vault's plugin folder; reload via the Obsidian CLI.
- Phone: install via Obsidian Sync on a test vault, debug via `chrome://inspect` over ADB.
- Unit tests (parser, scheduler replay, text cleanup) with a tiny test runner — no CI.

## 10. Open questions

1. Phone screen-lock behaviour during audio mode — test when the phone's next plugged in.
2. Does Obsidian on Android allow `fetch` to `http://127.0.0.1:<port>`? (Its page is
   `http://localhost`, so mixed content shouldn't block it; `requestUrl` is the fallback.)
