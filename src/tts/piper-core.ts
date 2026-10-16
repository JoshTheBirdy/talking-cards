// Piper text-to-speech: espeak phonemes (piper-phonemize, WASM) → phoneme IDs → VITS model
// (onnxruntime-web, WASM). Everything arrives as bytes, so this runs in the plugin's worker
// and under Node for tests. No network, no DOM.
import * as ort from "onnxruntime-web/wasm";

/** Must match the onnxruntime-web version in package.json and vendor/onnxruntime. */
/** Never fetched: the engine's bytes ship in main.js. onnxruntime-web@1.22.0 */
const ORT_WASM_NAME = "ort-wasm-simd-threaded.wasm";

export const ESPEAK_ROOT = "/usr/share/espeak-ng-data";
/** espeak files every language needs. Plus `lang/<family>/<voice>` and `<lang>_dict` per voice. */
export const ESPEAK_CORE = ["phontab", "phonindex", "phondata", "intonations"];

export interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers: number;
}

export interface EspeakFile {
  /** Relative to espeak-ng-data, e.g. `lang/gmw/en-GB-x-rp`. */
  path: string;
  data: Uint8Array;
}

// Emscripten module object; only the parts we touch.
interface PhonemizeModule {
  FS_createPath(parent: string, path: string, read: boolean, write: boolean): void;
  FS_createDataFile(parent: string, name: string, data: Uint8Array, read: boolean, write: boolean, own: boolean): void;
  FS_unlink(path: string): void;
  HEAP32: Int32Array;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, max: number): void;
  _malloc(n: number): number;
  _free(ptr: number): void;
  _PiperPhonemizeInitialize(dataDirPtr: number): number;
  _PiperPhonemizeText(textPtr: number, voicePtr: number): number;
  _PiperPhonemizeResultGetNumSentences(res: number): number;
  _PiperPhonemizeResultGetNumPhonemes(res: number, i: number): number;
  _PiperPhonemizeResultGetPhonemes(res: number, i: number): number;
  _PiperPhonemizeDestroyResult(res: number): void;
}

export class Phonemizer {
  private initialised = false;
  private M: PhonemizeModule;

  private constructor(M: PhonemizeModule) {
    this.M = M;
  }

  /**
   * Boots the Emscripten module from its glue source and wasm bytes. The glue's own 18 MB
   * data package is replaced by an empty one: it then creates every espeak file empty, and
   * `addFiles` overwrites just the ones a voice needs.
   */
  static load(glue: string, wasm: ArrayBuffer): Promise<Phonemizer> {
    return new Promise((resolve, reject) => {
      // Runs in the TTS worker, which has no `window`: `self` is the worker scope.
      const g = self as unknown as { Module: unknown; importScripts(url: string): void };
      const M: Record<string, unknown> = {
        wasmBinary: wasm,
        getPreloadedPackage: () => new ArrayBuffer(0),
        locateFile: (p: string) => p,
        print: () => {},
        printErr: () => {},
        onAbort: (e: unknown) => reject(new Error(`Phonemizer failed to start: ${String(e)}`)),
        onRuntimeInitialized: () => resolve(new Phonemizer(M as unknown as PhonemizeModule)),
      };
      g.Module = M;
      // The glue ships inside main.js; it runs as a classic worker script so `var Module` picks up the global above.
      const url = URL.createObjectURL(new Blob([glue], { type: "text/javascript" }));
      try {
        g.importScripts(url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        URL.revokeObjectURL(url);
      }
    });
  }

  addFiles(files: EspeakFile[]) {
    for (const f of files) {
      const slash = f.path.lastIndexOf("/");
      const dir = slash < 0 ? ESPEAK_ROOT : `${ESPEAK_ROOT}/${f.path.slice(0, slash)}`;
      const name = f.path.slice(slash + 1);
      if (slash >= 0) this.M.FS_createPath(ESPEAK_ROOT, f.path.slice(0, slash), true, true);
      try {
        this.M.FS_unlink(`${dir}/${name}`);
      } catch {
        // wasn't there
      }
      this.M.FS_createDataFile(dir, name, f.data, true, true, true);
    }
  }

  private str(s: string): number {
    const n = this.M.lengthBytesUTF8(s) + 1;
    const p = this.M._malloc(n);
    this.M.stringToUTF8(s, p, n);
    return p;
  }

  /** Text → one IPA string per sentence. Needs the core files and the voice's files added. */
  phonemize(text: string, voice: string): string[] {
    const M = this.M;
    if (!this.initialised) {
      const dir = this.str(ESPEAK_ROOT);
      try {
        if (M._PiperPhonemizeInitialize(dir) <= 0) throw new Error("espeak-ng failed to initialise (missing data files?)");
      } finally {
        M._free(dir);
      }
      this.initialised = true;
    }
    const t = this.str(text);
    const v = this.str(voice);
    try {
      const res = M._PiperPhonemizeText(t, v);
      if (!res) throw new Error(`Couldn't phonemize with espeak voice "${voice}"`);
      try {
        const out: string[] = [];
        const n = M._PiperPhonemizeResultGetNumSentences(res);
        for (let i = 0; i < n; i++) {
          const count = M._PiperPhonemizeResultGetNumPhonemes(res, i);
          const ptr = count > 0 ? M._PiperPhonemizeResultGetPhonemes(res, i) : 0;
          if (!ptr) continue;
          const codes = M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + count);
          out.push(String.fromCodePoint(...codes));
        }
        return out;
      } finally {
        M._PiperPhonemizeDestroyResult(res);
      }
    } finally {
      M._free(t);
      M._free(v);
    }
  }
}

/**
 * Points onnxruntime at wasm bytes we downloaded, single-threaded (no SharedArrayBuffer in Obsidian).
 * `glueUrl`: where to import its Emscripten glue from (a blob URL in the worker; Node finds it itself).
 */
export function configureOrt(wasm: ArrayBuffer, glueUrl?: string) {
  ort.env.wasm.wasmBinary = wasm;
  // The wasm path is never fetched (the bytes are above), but without one the glue tries to
  // resolve a URL relative to its own blob: address and throws.
  if (glueUrl) ort.env.wasm.wasmPaths = { mjs: glueUrl, wasm: ORT_WASM_NAME };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
}

/** Piper's phonemes_to_ids: BOS, pad, then each phoneme followed by pad, then EOS. */
export function phonemeIds(phonemes: string, map: Record<string, number[]>): number[] {
  const pad = map["_"] ?? [0];
  const ids = [...(map["^"] ?? []), ...pad];
  for (const ph of phonemes) {
    const id = map[ph];
    if (id) ids.push(...id, ...pad);
  }
  ids.push(...(map["$"] ?? []));
  return ids;
}

export interface SynthResult {
  samples: Float32Array;
  sampleRate: number;
}

export class PiperVoice {
  private session: ort.InferenceSession;
  readonly config: PiperConfig;

  private constructor(session: ort.InferenceSession, config: PiperConfig) {
    this.session = session;
    this.config = config;
  }

  static async load(model: Uint8Array, config: PiperConfig): Promise<PiperVoice> {
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return new PiperVoice(session, config);
  }

  /** Synthesises each sentence and joins them with Piper's default 0.2 s pause. */
  async synth(sentences: string[], speed = 1, speaker = 0): Promise<SynthResult> {
    const { inference, audio, phoneme_id_map, num_speakers } = this.config;
    const sr = audio.sample_rate;
    const gap = new Float32Array(Math.round(sr * 0.2));
    const parts: Float32Array[] = [];
    for (const s of sentences) {
      const ids = phonemeIds(s, phoneme_id_map);
      if (ids.length < 3) continue;
      const feeds: Record<string, ort.Tensor> = {
        input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor("float32", Float32Array.from([inference.noise_scale, inference.length_scale / speed, inference.noise_w]), [3]),
      };
      if (num_speakers > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(speaker)]), [1]);
      const out = await this.session.run(feeds);
      const data = out[this.session.outputNames[0]].data as Float32Array;
      if (parts.length) parts.push(gap);
      parts.push(data);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const samples = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      samples.set(p, o);
      o += p.length;
    }
    return { samples, sampleRate: sr };
  }

  async dispose() {
    await this.session.release();
  }
}

/** Which espeak files a voice needs, given the espeak-ng-data file listing. */
export function espeakFilesFor(espeakVoice: string, listing: string[]): string[] {
  const want = espeakVoice.toLowerCase();
  const lang = listing.find((p) => p.startsWith("lang/") && p.split("/").pop()!.toLowerCase() === want);
  const dict = `${want.split("-")[0]}_dict`;
  return [...ESPEAK_CORE, ...(lang ? [lang] : []), ...(listing.includes(dict) ? [dict] : [])];
}
