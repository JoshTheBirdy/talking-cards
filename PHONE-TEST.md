# Phone test day

## Results — mid-range Android phone, Android 16, Obsidian 1.14.4 (2026-10-14)

| | |
|---|---|
| Plugin in real Obsidian | ✅ loads, 12 cards, review log survives restarts |
| Built-in voice (Alba) | ✅ download 33 s, RTF 0.73, cold start 5.1 s (warm-up hides it), cache 13 ms |
| Phone voice via Reader 0.5.1 | ✅ 32 voices, Google en-GB is Automatic; 1.0 s for 2.2 s of audio |
| Keep screen on | ✅ Capacitor KeepAwake |
| Audio with screen off | ✅ AudioContext keeps running while locked |
| Swipes, real touch | ✅ all four directions — after stopping Obsidian's own sidebar/pull-down gestures on the card |
| Audio mode | ✅ question → 3 s countdown → answer → 2×2 grade zones |
| Found + fixed on the phone | grade buttons under Obsidian's mobile toolbar; swipes also opening sidebars; Reader 0.5.0 ANR on enabling the server; deck names cut off |
| Obsidian Sync (real vault) | ✅ desktop reviews reached the phone and a phone swipe-review reached the desktop within seconds; per-device logs, no conflicts; identical card states on both (13,997 cards) |
| Note | That vault's Sync doesn't sync plugins/settings: the plugin is installed per device (`scripts/phone-install.mjs` for the phone's app-folder vault) |

---


Everything below was built and dry-run on the desktop (Electron + `test/harness` + `fake-reader.mjs`).
What's left can only be learned on a real phone.

## 1. Automated run (≈10 minutes)

Phone: data cable, USB debugging on, unlocked, Obsidian open.

```bash
scripts/phone-test.sh --install-reader --reader-token PASTE_TOKEN_HERE
```

It builds and tests, pushes a **separate vault** (`Documents/Talking Cards Test`) with the plugin,
asks before updating Reader to 0.5.0 (`adb install -r`, keeps your library), then runs
`scripts/phone-checks.mjs` over Obsidian's debug socket. It refuses to run in any vault but the
test one. Results + screenshots land in `phone-results/`.

First time only, on the phone, when the script pauses:
1. Obsidian → switch vault → **Open folder as vault** → Documents/Talking Cards Test
2. Turn off Restricted mode, enable **Talking Cards**
3. Reader (after the update): Settings → Text-to-speech → **Let Talking Cards use my voices** → Copy
   the token (that's the `--reader-token`)

| Check | Learns |
|---|---|
| voice installed / speed test / synth ×3 / cold start | real WASM speed on the phone (desktop: RTF 0.26, cold 2.1 s) |
| Reader voice server / phone voice synth | Google voice through the bridge; latency |
| keep screen awake | Capacitor KeepAwake works from a plugin |
| real touch: tap + swipe up | swipe grading with a finger (`adb input`) |
| audio while locked | **lock the screen when asked** — does speech continue? |
| screenshots | layout at phone size, real theme |

## 2. By hand (≈10 minutes)

- [ ] Swipe all four directions with your thumb; does the tint/label feel right? Too sensitive?
- [ ] Audio mode through one deck with headphones; is the thinking time right?
- [ ] Settings screen: everything readable, nothing cut off
- [ ] Haptic tick when a swipe arms
- [ ] Rotate the phone mid-review

## 3. Sync (needs a real synced vault)

- [ ] Install the plugin into a synced vault on the desktop; Obsidian Sync carries it to the phone?
- [ ] Review 5 cards on the phone, 5 on the desktop (offline), reconnect: both logs present,
      counts right on both, nothing lost
- [ ] `Talking Cards/` added to Excluded files keeps logs out of search

## Known not-on-phone results

- Desktop Linux (Flatpak Obsidian) has no system voices → built-in voices there.
- Emulator not possible: no KVM on this machine.
