// Built-in neural voices: downloads, the worker that runs them, and the audio cache.
import { requestUrl } from "obsidian";
import workerSource from "tts-worker-source";
import { ORT_WASM_URL, espeakFilesFor, type EspeakFile, type PiperConfig } from "./piper-core.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { download, hashKey, idb, sha256 } from "./storage.ts";

const ORT_SHA256 = "71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4";
const ORT_SIZE = 11_210_254;

const VOICES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
// espeak-ng-data, one file at a time, from sherpa-onnx's mirror of a Piper voice.
const ESPEAK_BASE = "https://huggingface.co/csukuangfj/vits-piper-en_GB-alba-medium/resolve/main/espeak-ng-data";
const ESPEAK_LIST = "https://huggingface.co/api/models/csukuangfj/vits-piper-en_GB-alba-medium/tree/main/espeak-ng-data?recursive=1";

const CATALOGUE_MAX_AGE = 7 * 24 * 3600_000;
const IDLE_MS = 3 * 60_000;
const SPEED_TEST = "The quick brown fox jumps over the lazy dog, then naps in the afternoon sun.";

/** Voices that sound good and run fast enough on mid-range phones (fp32, medium quality). */
export const RECOMMENDED = [
  "en_GB-alba-medium", "en_GB-cori-medium", "en_GB-jenny_dioco-medium", "en_GB-northern_english_male-medium",
  "en_US-amy-medium", "en_US-ryan-medium", "en_US-lessac-medium", "en_US-hfc_female-medium",
];

export interface CatalogueVoice {
  key: string;
  name: string;
  language: { code: string; family: string; name_english: string; country_english: string; name_native?: string };
  quality: "x_low" | "low" | "medium" | "high";
  num_speakers: number;
  files: Record<string, { size_bytes: number; md5_digest: string }>;
}

export interface InstalledVoice {
  key: string;
  name: string;
  /** e.g. en_GB */
  lang: string;
  langName: string;
  quality: string;
  bytes: number;
  installedAt: number;
  /** Synthesis time ÷ audio length on this device. < 1 keeps up with playback. */
  rtf?: number;
  config: PiperConfig;
}

export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

interface CachedAudio {
  pcm: Int16Array;
  sampleRate: number;
}

interface AudioMeta {
  bytes: number;
  usedAt: number;
  voice: string;
}

export class PiperEngine {
  installed = new Map<string, InstalledVoice>();
  /** Max audio cache size in bytes. */
  cacheLimit = 200 * 1024 * 1024;

  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private booting: Promise<void> | null = null;
  private seq = 0;
  private calls = new Map<number, { resolve: (m: FromWorker) => void; reject: (e: Error) => void }>();
  private loadedVoices = new Set<string>();
  private sentEspeak = new Set<string>();
  private idleTimer: number | null = null;
  private inflight = new Map<string, Promise<Audio>>();
  /** Bytes of cached audio; null until first counted (Tts.init counts it at startup). */
  cacheBytes: number | null = null;

  async init() {
    try {
      for (const v of await idb.all<InstalledVoice>("voices")) this.installed.set(v.key, v);
    } catch (e) {
      console.warn("Talking Cards: voice storage unavailable", e);
    }
  }

  async catalogue(force = false): Promise<Record<string, CatalogueVoice>> {
    const cached = await idb.get<{ at: number; data: Record<string, CatalogueVoice> }>("files", "catalogue");
    if (cached && !force && Date.now() - cached.at < CATALOGUE_MAX_AGE) return cached.data;
    try {
      const data = JSON.parse(new TextDecoder().decode(await download(`${VOICES_BASE}/voices.json`))) as Record<string, CatalogueVoice>;
      await idb.put("files", "catalogue", { at: Date.now(), data });
      return data;
    } catch (e) {
      if (cached) return cached.data;
      throw e;
    }
  }

  /** Downloads the engine (once), the voice, and its espeak language files; then speed-tests it. */
  async install(v: CatalogueVoice, onProgress: (what: string, loaded: number, total: number) => void, signal?: AbortSignal) {
    if (!(await idb.get("files", "ort-wasm"))) {
      const wasm = await download(ORT_WASM_URL, ORT_SIZE, (l, t) => onProgress("Voice engine", l, t), signal);
      if ((await sha256(wasm)) !== ORT_SHA256) throw new Error("Voice engine download is corrupt (checksum mismatch)");
      await idb.put("files", "ort-wasm", wasm);
    }
    const onnxPath = Object.keys(v.files).find((p) => p.endsWith(".onnx"))!;
    const jsonPath = Object.keys(v.files).find((p) => p.endsWith(".onnx.json"))!;
    const config = JSON.parse(new TextDecoder().decode(await download(`${VOICES_BASE}/${jsonPath}`, undefined, undefined, signal))) as PiperConfig;
    const size = v.files[onnxPath].size_bytes;
    const model = await download(`${VOICES_BASE}/${onnxPath}`, size, (l, t) => onProgress("Voice", l, t), signal);

    const espeak = await this.espeakFiles(config.espeak.voice);
    let n = 0;
    for (const path of espeak) {
      if (!(await idb.get("files", `espeak:${path}`))) {
        const data = await download(`${ESPEAK_BASE}/${encodeURI(path)}`, undefined, undefined, signal);
        await idb.put("files", `espeak:${path}`, data);
      }
      onProgress("Language data", ++n, espeak.length);
    }

    await idb.put("files", `voice:${v.key}`, model);
    const rec: InstalledVoice = {
      key: v.key,
      name: v.name,
      lang: v.language.code,
      langName: `${v.language.name_english} (${v.language.country_english})`,
      quality: v.quality,
      bytes: size,
      installedAt: Date.now(),
      config,
    };
    this.installed.set(v.key, rec);
    await idb.put("voices", v.key, rec);
    onProgress("Testing speed", 0, 1);
    await this.speedTest(v.key);
  }

  async speedTest(key: string): Promise<number> {
    const a = await this.render(SPEED_TEST, key, 1);
    const rec = this.installed.get(key)!;
    rec.rtf = a.ms / ((a.audio.samples.length / a.audio.sampleRate) * 1000);
    await idb.put("voices", key, rec);
    return rec.rtf;
  }

  async remove(key: string) {
    if (this.loadedVoices.has(key)) {
      await this.call({ type: "unload", id: 0, key });
      this.loadedVoices.delete(key);
    }
    this.installed.delete(key);
    await idb.del("voices", key);
    await idb.del("files", `voice:${key}`);
    const metas = await idb.keys("audioMeta");
    for (const k of metas) {
      const m = await idb.get<AudioMeta>("audioMeta", k);
      if (m?.voice === key) await this.dropAudio(k, m);
    }
  }

  private async espeakFiles(espeakVoice: string): Promise<string[]> {
    let listing = await idb.get<string[]>("files", "espeak-listing");
    if (!listing) {
      const res = await requestUrl({ url: ESPEAK_LIST, throw: false });
      if (res.status !== 200) throw new Error(`Couldn't list language data (${res.status})`);
      const tree = res.json as { type: string; path: string }[];
      listing = tree.filter((f) => f.type === "file").map((f) => f.path.replace(/^espeak-ng-data\//, ""));
      await idb.put("files", "espeak-listing", listing);
    }
    return espeakFilesFor(espeakVoice, listing);
  }

  // ---------- worker ----------

  private boot(): Promise<void> {
    this.booting ??= (async () => {
      const ort = await idb.get<ArrayBuffer>("files", "ort-wasm");
      if (!ort) throw new Error("No voices installed yet — open the voice store in Talking Cards settings");
      this.workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      this.worker = new Worker(this.workerUrl);
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const c = this.calls.get(e.data.id);
        if (!c) return;
        this.calls.delete(e.data.id);
        if (e.data.type === "error") c.reject(new Error(e.data.message));
        else c.resolve(e.data);
      };
      this.worker.onerror = (e) => {
        for (const c of this.calls.values()) c.reject(new Error(e.message || "Voice engine crashed"));
        this.calls.clear();
        this.shutdown();
      };
      await this.call({ type: "init", id: 0, ortWasm: ort }, [ort]);
    })().catch((e) => {
      this.shutdown();
      throw e;
    });
    return this.booting;
  }

  private call(msg: ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (!this.worker) return reject(new Error("Voice engine not running"));
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Frees the model memory after a few idle minutes; it reloads on next use. */
  private touch() {
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.shutdown(), IDLE_MS);
  }

  shutdown() {
    this.worker?.terminate();
    this.worker = null;
    this.booting = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    this.loadedVoices.clear();
    this.sentEspeak.clear();
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Starts the engine and loads a voice in the background, so the first card doesn't wait. */
  warm(key: string) {
    this.ensureVoice(key).then(() => this.touch()).catch(() => {});
  }

  private async ensureVoice(key: string) {
    await this.boot();
    if (this.loadedVoices.has(key)) return;
    const rec = this.installed.get(key);
    if (!rec) throw new Error(`Voice ${key} isn't installed`);
    const files: EspeakFile[] = [];
    for (const path of await this.espeakFiles(rec.config.espeak.voice)) {
      if (this.sentEspeak.has(path)) continue;
      const data = await idb.get<ArrayBuffer>("files", `espeak:${path}`);
      if (!data) throw new Error(`Language data missing for ${rec.name} — reinstall the voice`);
      files.push({ path, data: new Uint8Array(data) });
    }
    if (files.length) {
      await this.call({ type: "espeak", id: 0, files });
      files.forEach((f) => this.sentEspeak.add(f.path));
    }
    const model = await idb.get<ArrayBuffer>("files", `voice:${key}`);
    if (!model) throw new Error(`Voice ${key} is missing its model — reinstall it`);
    await this.call({ type: "voice", id: 0, key, model, config: rec.config }, [model]);
    this.loadedVoices.add(key);
  }

  private async render(text: string, key: string, speed: number): Promise<{ audio: Audio; ms: number }> {
    await this.ensureVoice(key);
    this.touch();
    const r = await this.call({ type: "synth", id: 0, key, text, speed });
    if (r.type !== "audio") throw new Error("Unexpected reply from voice engine");
    this.touch();
    return { audio: { samples: r.samples, sampleRate: r.sampleRate }, ms: r.ms };
  }

  // ---------- cached synthesis ----------

  /** Audio for text, from cache or freshly synthesised. Concurrent requests for the same text share one job. */
  synth(text: string, key: string, speed: number): Promise<Audio> {
    return this.cached(text, key, speed, async () => (await this.render(text, key, speed)).audio);
  }

  /**
   * The shared audio cache, for any engine that produces samples (built-in voices, Reader).
   * `voice` names the voice in the cache key, e.g. "en_GB-alba-medium" or "reader:system:…".
   */
  cached(text: string, voice: string, speed: number, render: () => Promise<Audio>): Promise<Audio> {
    const ck = hashKey(`${voice}|${speed.toFixed(2)}|${text}`);
    let job = this.inflight.get(ck);
    if (!job) {
      job = this.cachedOrRender(ck, voice, render).finally(() => this.inflight.delete(ck));
      this.inflight.set(ck, job);
    }
    return job;
  }

  private async cachedOrRender(ck: string, key: string, render: () => Promise<Audio>): Promise<Audio> {
    const hit = await idb.get<CachedAudio>("audio", ck).catch(() => undefined);
    if (hit) {
      void idb.put("audioMeta", ck, { bytes: hit.pcm.byteLength, usedAt: Date.now(), voice: key } satisfies AudioMeta).catch(() => {});
      return { samples: fromPcm(hit.pcm), sampleRate: hit.sampleRate };
    }
    const audio = await render();
    const pcm = toPcm(audio.samples);
    try {
      await idb.put("audio", ck, { pcm, sampleRate: audio.sampleRate } satisfies CachedAudio);
      await idb.put("audioMeta", ck, { bytes: pcm.byteLength, usedAt: Date.now(), voice: key } satisfies AudioMeta);
      this.cacheBytes = (await this.cacheSize()) + pcm.byteLength;
      if (this.cacheBytes > this.cacheLimit) void this.evict();
    } catch (e) {
      console.warn("Talking Cards: couldn't cache audio", e);
    }
    return { samples: fromPcm(pcm), sampleRate: audio.sampleRate };
  }

  async cacheSize(): Promise<number> {
    if (this.cacheBytes === null) {
      const metas = await idb.all<AudioMeta>("audioMeta");
      this.cacheBytes = metas.reduce((n, m) => n + m.bytes, 0);
    }
    return this.cacheBytes;
  }

  private async evict() {
    const keys = await idb.keys("audioMeta");
    const metas = await idb.all<AudioMeta>("audioMeta");
    const order = keys.map((k, i) => ({ k, m: metas[i] })).sort((a, b) => a.m.usedAt - b.m.usedAt);
    let total = order.reduce((n, x) => n + x.m.bytes, 0);
    for (const { k, m } of order) {
      if (total <= this.cacheLimit * 0.8) break;
      await this.dropAudio(k, m);
      total -= m.bytes;
    }
    this.cacheBytes = total;
  }

  private async dropAudio(k: string, m: AudioMeta) {
    await idb.del("audio", k);
    await idb.del("audioMeta", k);
    if (this.cacheBytes !== null) this.cacheBytes -= m.bytes;
  }

  async clearCache() {
    await idb.clear("audio");
    await idb.clear("audioMeta");
    this.cacheBytes = 0;
  }
}

/** Cached as 16-bit to halve storage; normalised so quiet voices aren't quiet. */
function toPcm(f: Float32Array): Int16Array {
  let peak = 0;
  for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
  const gain = peak > 0.01 ? 0.95 / peak : 1;
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-1, Math.min(1, f[i] * gain)) * 32767;
  return out;
}

function fromPcm(p: Int16Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / 32768;
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
