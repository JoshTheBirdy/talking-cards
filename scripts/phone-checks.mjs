// Automated checks inside Obsidian on the phone, over Chrome DevTools Protocol.
// Run by scripts/phone-test.sh, which forwards the WebView's debug socket to localhost:9333.
//   node scripts/phone-checks.mjs [--reader-token TOKEN] [--skip-download]
// Refuses to run unless the open vault is the test vault: it never touches a real vault.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const TEST_VAULT = "Talking Cards Test";
const args = process.argv.slice(2);
// DRYRUN=1: run against the browser harness (Electron on :9333) instead of a phone; adb is faked.
const DRY = process.env.DRYRUN === "1";
const readerToken = args.includes("--reader-token") ? args[args.indexOf("--reader-token") + 1] : "";
const skipDownload = args.includes("--skip-download");
/** Press the power button over adb mid-speech instead of asking a person to lock the phone. */
const autoLock = args.includes("--auto-lock");
const outDir = new URL("../phone-results/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const results = [];
const report = (status, name, detail = "") => {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(5)} ${name}${detail ? " — " + detail : ""}`);
};

const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = pages.find((p) => p.type === "page" && (DRY ? /harness/.test(p.title) : /Obsidian/.test(p.title)));
if (!page) throw new Error("No Obsidian page on the debug socket — is Obsidian open on the phone?");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (waiting.has(d.id)) {
    waiting.get(d.id)(d);
    waiting.delete(d.id);
  }
};
/** Evaluates an async JS expression in Obsidian and returns its value. */
async function js(expr, timeoutMs = 120_000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true } }));
  const d = await Promise.race([new Promise((r) => waiting.set(id, r)), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
  if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? "JS error");
  return d.result?.result?.value;
}
const adb = (...a) => execFileSync("adb", a, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
/** Raw CDP call. */
function cdp(method, params = {}, timeoutMs = 8000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return Promise.race([
    new Promise((r) => waiting.set(id, r)),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} timed out`)), timeoutMs)),
  ]);
}
const screenshot = async (name) => {
  try {
    if (DRY) {
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${outDir}${name}.png`, Buffer.from(shot.result.data, "base64"));
    } else writeFileSync(`${outDir}${name}.png`, adb("exec-out", "screencap", "-p"));
    report("INFO", `screenshot ${name}.png`);
  } catch (e) {
    report("WARN", `screenshot ${name}`, e.message);
  }
};
/** A real gesture: adb input on the phone, CDP mouse events in a dry run. Coordinates are fractions of the screen. */
async function gesture(fx0, fy0, fx1 = fx0, fy1 = fy0) {
  if (!DRY) {
    const size = adb("shell", "wm", "size").toString().match(/(\d+)x(\d+)/);
    const [W, H] = [Number(size[1]), Number(size[2])];
    if (fx0 === fx1 && fy0 === fy1) adb("shell", "input", "tap", String(W * fx0), String(H * fy0));
    else adb("shell", "input", "swipe", String(W * fx0), String(H * fy0), String(W * fx1), String(H * fy1), "250");
    return;
  }
  const { w, h } = await js(`return { w: innerWidth, h: innerHeight }`);
  const m = (type, fx, fy) => cdp("Input.dispatchMouseEvent", { type, x: w * fx, y: h * fy, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  await m("mousePressed", fx0, fy0);
  for (let i = 1; i <= 6; i++) await m("mouseMoved", fx0 + ((fx1 - fx0) * i) / 6, fy0 + ((fy1 - fy0) * i) / 6);
  await m("mouseReleased", fx1, fy1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. environment & safety ----
const env = await js(`return { vault: app.vault.getName(), ua: navigator.userAgent, speech: typeof speechSynthesis !== "undefined", plugin: !!app.plugins.plugins["talking-cards"], version: app.plugins.manifests["talking-cards"]?.version }`);
if (env.vault !== TEST_VAULT) {
  console.error(`Open vault is "${env.vault}", not "${TEST_VAULT}". Stopping so nothing touches your real vault.`);
  process.exit(2);
}
report("INFO", "device", env.ua.match(/Android [\d.]+; [^)]+/)?.[0] ?? env.ua);
report(env.plugin ? "PASS" : "FAIL", "plugin loaded", env.version ?? "not enabled — enable it in Settings → Community plugins");
if (!env.plugin) process.exit(1);
const P = `const p = app.plugins.plugins["talking-cards"];`;

// ---- 2. cards ----
const idx = await js(`${P} for (let i=0;i<50 && !(p.index.ready && p.store.ready);i++) await new Promise(r=>setTimeout(r,100)); return { cards: p.index.allCards().length, notes: p.index.notes.size, device: p.store.deviceId }`);
report(idx.cards > 0 ? "PASS" : "FAIL", "cards indexed", `${idx.cards} cards in ${idx.notes} notes, device ${idx.device}`);

// ---- 3. screens ----
await js(`${P} await p.openDashboard(); return true`);
await sleep(800);
await screenshot("1-dashboard");
await js(`${P} await p.openDashboard(undefined, "stats"); return true`);
await sleep(1500);
await screenshot("2-stats");

// ---- 4. built-in voice ----
let voice = await js(`${P} return [...p.tts.piper.installed.keys()][0] ?? null`);
if (!voice && !skipDownload) {
  report("INFO", "downloading en_GB-alba-medium (~70 MB incl. engine)…");
  const t = Date.now();
  voice = await js(`${P} const cat = await p.tts.piper.catalogue(); await p.tts.piper.install(cat["en_GB-alba-medium"], () => {}); return "en_GB-alba-medium"`, 600_000);
  report("PASS", "voice installed", `${Math.round((Date.now() - t) / 1000)} s`);
}
if (voice) {
  const rtf = await js(`${P} return p.tts.piper.installed.get(${JSON.stringify(voice)}).rtf`);
  report(rtf < 1 ? "PASS" : "WARN", "built-in voice speed test", `RTF ${rtf?.toFixed(2)} (${rtf < 1 ? "faster than playback" : "slower than playback — look-ahead must hide it"})`);
  const cold = await js(`${P} p.tts.piper.shutdown(); const t0 = performance.now(); await p.tts.piper.render("Hello.", ${JSON.stringify(voice)}, 1); return Math.round(performance.now() - t0)`, 300_000);
  report(cold < 4000 ? "PASS" : "WARN", "cold start (engine boot + voice load + first line)", `${cold} ms — the plugin hides this by warming up when the dashboard opens`);
  const timings = await js(`${P}
    const out = [];
    for (const text of ["Mitochondria.", "What is the powerhouse of the cell?", "Prophase, metaphase, anaphase and telophase are the four stages of mitosis, in order."]) {
      const t0 = performance.now();
      // Straight to the engine (no cache), so every run measures real synthesis.
      const { audio: a } = await p.tts.piper.render(text, ${JSON.stringify(voice)}, 1);
      out.push({ chars: text.length, ms: Math.round(performance.now() - t0), audioMs: Math.round(a.samples.length / a.sampleRate * 1000) });
    }
    await p.tts.piper.synth("What is the powerhouse of the cell?", ${JSON.stringify(voice)}, 1);
    const t2 = performance.now(); await p.tts.piper.synth("What is the powerhouse of the cell?", ${JSON.stringify(voice)}, 1);
    return { out, cached: Math.round(performance.now() - t2) };`, 300_000);
  for (const t of timings.out) report(t.ms < t.audioMs ? "PASS" : "WARN", `synth ${t.chars} chars`, `${t.ms} ms for ${t.audioMs} ms of audio`);
  report(timings.cached < 100 ? "PASS" : "WARN", "cached repeat", `${timings.cached} ms`);
}

// ---- 5. phone voices via Reader ----
if (readerToken) {
  const r = await js(`${P} p.tts.prefs.readerToken = ${JSON.stringify(readerToken)}; p.tts.savePrefs(); await p.tts.reader.check(); return { status: p.tts.reader.status, msg: p.tts.reader.message, voices: p.tts.reader.voices.length, auto: p.tts.describe(p.tts.resolve("")) }`);
  report(r.status === "ok" ? "PASS" : "FAIL", "Reader voice server", r.msg);
  if (r.status === "ok") {
    report("INFO", "automatic voice now", r.auto);
    const t = await js(`${P} const t0 = performance.now(); const v = p.tts.reader.defaultVoice(); const a = await p.tts.reader.synth("What is the powerhouse of the cell?", v.id, 1); return { ms: Math.round(performance.now() - t0), audioMs: Math.round(a.samples.length / a.sampleRate * 1000), rate: a.sampleRate }`);
    report(t.ms < 2000 ? "PASS" : "WARN", "phone voice synth", `${t.ms} ms for ${t.audioMs} ms of audio at ${t.rate} Hz`);
  }
} else {
  report("SKIP", "Reader voice server", "pass --reader-token TOKEN (Reader → Settings → Text-to-speech)");
}

// ---- 6. keep awake ----
const ka = await js(`const k = window.Capacitor?.Plugins?.KeepAwake; if (!k) return "missing"; try { await k.keepAwake(); await k.allowSleep(); return "ok"; } catch (e) { return String(e); }`);
report(ka === "ok" ? "PASS" : "FAIL", "keep screen awake (Capacitor KeepAwake)", ka);

// ---- 7. review + real touch swipes ----
await js(`${P} p.settings.autoReadFront = false; p.settings.autoReadBack = false; await p.study({ kind: "all", value: "" }); return true`);
await sleep(1200);
await screenshot("3-review-front");
const before = await js(`${P} return p.store.entries.length`);
await gesture(0.5, 0.45);
await sleep(700);
await screenshot("4-review-revealed");
await gesture(0.5, 0.5, 0.5, 0.2);
await sleep(900);
const after = await js(`${P} return { n: p.store.entries.length, last: p.store.entries.at(-1)?.r }`);
report(after.n === before + 1 && after.last === 3 ? "PASS" : "FAIL", "real touch: tap reveals, swipe up grades Good", JSON.stringify(after));

// ---- 8. audio with the screen locked ----
if (voice || readerToken) {
  console.log("\n>>> Audio test: the phone will read a long passage. LOCK THE SCREEN within 5 seconds, and listen.");
  await js(`${P} window.__audioLog = []; p.tts.unlock(); const ctx = p.tts.ctx; document.addEventListener("visibilitychange", () => window.__audioLog.push([Date.now(), document.visibilityState, p.tts.ctx?.state])); setInterval(() => window.__audioLog.push([Date.now(), document.visibilityState, p.tts.ctx?.state]), 2000); p.tts.speak("This is a long test passage. ".repeat(12) + "If you can still hear this with the screen locked, background audio works.", "").catch(e => window.__audioLog.push(["error", String(e)])); return true`);
  if (autoLock && !DRY) {
    await sleep(5000);
    adb("shell", "input", "keyevent", "KEYCODE_POWER"); // screen off
    await sleep(25_000);
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    await sleep(3000);
    console.log(">>> If the phone has a PIN it's now on the lock screen: unlock it to continue testing.");
  } else await sleep(DRY ? 4000 : 35_000);
  const log = await js(`return window.__audioLog`);
  writeFileSync(`${outDir}audio-lock-log.json`, JSON.stringify(log, null, 1));
  const hidden = log.filter((l) => l[1] === "hidden");
  const suspended = hidden.some((l) => l[2] !== "running");
  report(hidden.length ? (suspended ? "WARN" : "PASS") : "SKIP", "audio while locked", hidden.length ? `AudioContext while hidden: ${[...new Set(hidden.map((l) => l[2]))].join(", ")} — also note whether you heard it` : "screen wasn't locked");
}

writeFileSync(`${outDir}results.json`, JSON.stringify(results, null, 1));
console.log(`\nDone. Results and screenshots in ${outDir}`);
ws.close();
