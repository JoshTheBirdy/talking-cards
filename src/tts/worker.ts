// Runs inside a Web Worker so synthesis never blocks the review screen.
// Bundled separately (see esbuild.config.mjs) and embedded in main.js as a string.
import glue from "../../vendor/piper-phonemize/phonemize.glue.js";
import phonemizeWasm from "../../vendor/piper-phonemize/phonemize.wasm";
import ortGlue from "../../vendor/onnxruntime/ort-wasm-simd-threaded.glue.js";
import { Phonemizer, PiperVoice, configureOrt } from "./piper-core.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

let phonemizer: Phonemizer | null = null;
const voices = new Map<string, PiperVoice>();

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

/** The request being handled, so errors thrown outside our awaits still reach the caller. */
let current = 0;
const fail = (e: unknown) => {
  const err: unknown = (e as PromiseRejectionEvent)?.reason ?? (e as ErrorEvent)?.error ?? e;
  post({ type: "error", id: current, message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
};
self.addEventListener("unhandledrejection", fail);
self.addEventListener("error", fail);

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  current = m.id;
  try {
    switch (m.type) {
      case "init": {
        configureOrt(m.ortWasm, URL.createObjectURL(new Blob([ortGlue], { type: "text/javascript" })));
        const wasm = phonemizeWasm;
        phonemizer ??= await Phonemizer.load(glue, wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
        return post({ type: "ok", id: m.id });
      }
      case "espeak":
        need(phonemizer).addFiles(m.files);
        return post({ type: "ok", id: m.id });
      case "voice": {
        if (!voices.has(m.key)) voices.set(m.key, await PiperVoice.load(new Uint8Array(m.model), m.config));
        return post({ type: "ok", id: m.id });
      }
      case "unload": {
        await voices.get(m.key)?.dispose();
        voices.delete(m.key);
        return post({ type: "ok", id: m.id });
      }
      case "synth": {
        const voice = voices.get(m.key);
        if (!voice) throw new Error(`Voice ${m.key} isn't loaded`);
        const t0 = performance.now();
        const sentences = need(phonemizer).phonemize(m.text, voice.config.espeak.voice);
        const { samples, sampleRate } = await voice.synth(sentences, m.speed, m.speaker ?? 0);
        return post({ type: "audio", id: m.id, samples, sampleRate, ms: performance.now() - t0 }, [samples.buffer]);
      }
    }
  } catch (e) {
    post({ type: "error", id: m.id, message: e instanceof Error ? e.message : String(e) });
  }
};

function need<T>(x: T | null): T {
  if (!x) throw new Error("TTS engine not initialised");
  return x;
}
