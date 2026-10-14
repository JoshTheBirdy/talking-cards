// Picks a voice for each card side and speaks it. Engines: built-in Piper (everywhere) and the
// OS voices via Web Speech where they exist (Windows/macOS desktop; not Android or Flatpak Linux).
import { Platform, requestUrl, type App } from "obsidian";
import { PiperEngine, RECOMMENDED, type Audio } from "./piper-engine.ts";
import { READER_PORT, ReaderBridge, type Requester } from "./reader-bridge.ts";

const PREFS_KEY = "talking-cards-voice";

/** Per device, so the phone and laptop can use different voices. */
export interface VoicePrefs {
  /** "" = automatic, "piper:<key>", "system:<voiceURI>" */
  front: string;
  back: string;
  speed: number;
  /** Token from Reader → Settings → Text-to-speech (phone only). */
  readerToken: string;
  readerPort: number;
  /** Settings shows the companion-app section (phone only; off until the user asks for it). */
  readerOn?: boolean;
}

type Resolved =
  | { kind: "piper"; key: string }
  | { kind: "system"; voice: SpeechSynthesisVoice }
  | { kind: "reader"; id: string; name: string };

/** Obsidian's requestUrl goes through native HTTP on mobile, so the Reader server needs no CORS. */
const obsidianRequest: Requester = async ({ url, method, headers, body }) => {
  const r = await requestUrl({ url, method, headers, body, throw: false });
  return { status: r.status, arrayBuffer: r.arrayBuffer, text: r.text };
};

export class Tts {
  piper = new PiperEngine();
  reader: ReaderBridge;
  prefs: VoicePrefs;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private token = 0;
  private systemList: SpeechSynthesisVoice[] = [];

  constructor(private app: App) {
    const saved = app.loadLocalStorage(PREFS_KEY) as Partial<VoicePrefs> | null;
    this.prefs = { front: "", back: "", speed: 1, readerToken: "", readerPort: READER_PORT, ...(saved ?? {}) };
    this.reader = new ReaderBridge(obsidianRequest, () => ({ token: this.prefs.readerToken, port: this.prefs.readerPort }));
  }

  async init() {
    await this.piper.init();
    this.systemList = await loadSystemVoices();
    if (this.prefs.readerToken) await this.reader.check();
  }

  savePrefs() {
    this.app.saveLocalStorage(PREFS_KEY, this.prefs);
  }

  systemVoices(): SpeechSynthesisVoice[] {
    return this.systemList;
  }

  /** Call from a tap/click: mobile browsers only allow audio to start from a user gesture. */
  unlock() {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /**
   * Turns a preference (+ optional per-note override like "es" or "piper:es_ES-…") into a voice.
   * Overrides that name a language pick an installed voice for it.
   */
  resolve(pref: string, override?: string): Resolved | null {
    for (const want of [override, pref]) {
      if (!want) continue;
      if (want.startsWith("piper:") && this.piper.installed.has(want.slice(6))) return { kind: "piper", key: want.slice(6) };
      if (want.startsWith("reader:")) {
        const v = this.reader.voices.find((x) => x.id === want.slice(7));
        if (v) return { kind: "reader", id: v.id, name: v.name };
      }
      if (want.startsWith("system:")) {
        const v = this.systemList.find((x) => x.voiceURI === want.slice(7));
        if (v) return { kind: "system", voice: v };
      }
      if (!want.includes(":")) {
        const lang = want.toLowerCase().replace("_", "-");
        const rv = this.reader.voices.find((v) => v.lang.toLowerCase().replace("_", "-").startsWith(lang));
        if (rv) return { kind: "reader", id: rv.id, name: rv.name };
        const p = this.installedPiper().find((v) => v.lang.toLowerCase().replace("_", "-").startsWith(lang));
        if (p) return { kind: "piper", key: p.key };
        const s = this.systemList.find((v) => v.lang.toLowerCase().replace("_", "-").startsWith(lang));
        if (s) return { kind: "system", voice: s };
      }
    }
    // Automatic: the phone's own voice via Reader when it's there; the OS voice on desktops that
    // have one; otherwise the first built-in voice.
    const rd = this.reader.status === "ok" ? this.reader.defaultVoice() : undefined;
    if (rd) return { kind: "reader", id: rd.id, name: rd.name };
    if (!Platform.isMobile) {
      const def = this.systemList.find((v) => v.default) ?? this.systemList[0];
      if (def) return { kind: "system", voice: def };
    }
    const first = this.installedPiper()[0];
    return first ? { kind: "piper", key: first.key } : null;
  }

  /** Installed built-in voices, recommended ones first. */
  installedPiper() {
    const rank = (k: string) => (RECOMMENDED.includes(k) ? RECOMMENDED.indexOf(k) : 99);
    return [...this.piper.installed.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  }

  hasAnyVoice(): boolean {
    return !!this.resolve("");
  }

  describe(r: Resolved | null): string {
    if (!r) return "none";
    if (r.kind === "reader") return r.name;
    return r.kind === "piper" ? this.piper.installed.get(r.key)!.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : r.voice.name;
  }

  /** Loads the built-in voice(s) that will be used, ahead of the first card. */
  warm() {
    for (const pref of [this.prefs.front, this.prefs.back]) {
      const r = this.resolve(pref);
      if (r?.kind === "piper") this.piper.warm(r.key);
    }
  }

  /** Warms the cache so the audio is ready when needed. Built-in voices only. */
  prefetch(text: string, pref: string, override?: string) {
    const r = this.resolve(pref, override);
    if (!r || !text) return;
    if (r.kind === "piper") this.piper.synth(text, r.key, this.prefs.speed).catch(() => {});
    if (r.kind === "reader") this.readerAudio(text, r.id).catch(() => {});
  }

  /** Speaks, stopping anything already playing. Resolves when finished or interrupted. */
  async speak(text: string, pref: string, override?: string): Promise<void> {
    this.stop();
    const token = this.token;
    if (!text) return;
    const r = this.resolve(pref, override);
    if (!r) throw new Error("No voice yet — download one in Settings → Talking Cards → Voice store");
    if (r.kind === "system") return speakSystem(text, r.voice, this.prefs.speed, () => token !== this.token);
    const audio = r.kind === "reader" ? await this.readerAudio(text, r.id) : await this.piper.synth(text, r.key, this.prefs.speed);
    if (token !== this.token) return; // moved on while it was rendering
    await this.play(audio, token);
  }

  /** Reader's audio goes through the same cache as the built-in voices. */
  private readerAudio(text: string, id: string): Promise<Audio> {
    const speed = this.prefs.speed;
    return this.piper.cached(text, `reader:${id}`, speed, () => this.reader.synth(text, id, speed));
  }

  stop() {
    this.token++;
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source = null;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }

  private play(a: Audio, token: number): Promise<void> {
    this.unlock();
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, a.samples.length, a.sampleRate);
    buf.copyToChannel(a.samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    return new Promise((resolve) => {
      src.onended = () => resolve();
      if (token !== this.token) return resolve();
      this.source = src;
      src.start();
    });
  }

  unload() {
    this.stop();
    this.piper.shutdown();
    void this.ctx?.close();
  }
}

function loadSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve([]);
  return new Promise((resolve) => {
    const now = speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    window.setTimeout(done, 1500);
  });
}

function speakSystem(text: string, voice: SpeechSynthesisVoice, rate: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (cancelled()) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = rate;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}
