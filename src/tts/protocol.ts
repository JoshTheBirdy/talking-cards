// Messages between the plugin and the TTS worker. Types only.
import type { EspeakFile, PiperConfig } from "./piper-core.ts";

export type ToWorker =
  | { type: "init"; id: number; ortWasm: ArrayBuffer }
  | { type: "espeak"; id: number; files: EspeakFile[] }
  | { type: "voice"; id: number; key: string; model: ArrayBuffer; config: PiperConfig }
  | { type: "unload"; id: number; key: string }
  | { type: "synth"; id: number; key: string; text: string; speed: number; speaker?: number };

export type FromWorker =
  | { type: "ok"; id: number }
  | { type: "audio"; id: number; samples: Float32Array; sampleRate: number; ms: number }
  | { type: "error"; id: number; message: string };
