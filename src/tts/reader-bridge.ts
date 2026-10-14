// The phone's own voices, via a companion app's voice server (Reader → Settings → Text-to-speech →
// "Let Talking Cards use my voices"). A plugin can't call Android's TextToSpeech; an app can.
// Protocol: docs/voice-server.md — any app that implements it works.
import type { Audio } from "./piper-engine.ts";

export const READER_PORT = 51515;

export interface ReaderVoice {
  /** "system:<android voice>" or "neural:<pack>:<speaker>" */
  id: string;
  name: string;
  lang: string;
  kind: "system" | "neural";
  default: boolean;
}

export type BridgeStatus = "unknown" | "no-token" | "unreachable" | "bad-token" | "ok";

/** Minimal HTTP: Obsidian's requestUrl in the plugin (no CORS on mobile), fetch in tests. */
export type Requester = (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  arrayBuffer: ArrayBuffer;
  text: string;
}>;

export class ReaderBridge {
  status: BridgeStatus = "unknown";
  voices: ReaderVoice[] = [];
  version = "";
  message = "";

  private request: Requester;
  private settings: () => { token: string; port: number };

  constructor(request: Requester, settings: () => { token: string; port: number }) {
    this.request = request;
    this.settings = settings;
  }

  private url(path: string) {
    return `http://127.0.0.1:${this.settings().port || READER_PORT}${path}`;
  }

  private headers(): Record<string, string> {
    return { "X-Reader-Token": this.settings().token.trim(), "Content-Type": "application/json" };
  }

  /** Looks for Reader and loads its voices. Cheap; call when settings open or a session starts. */
  async check(): Promise<BridgeStatus> {
    if (!this.settings().token.trim()) return this.set("no-token", "Paste the token from Reader → Settings → Text-to-speech.");
    try {
      const st = await this.request({ url: this.url("/status"), method: "GET", headers: this.headers() });
      if (st.status === 401) return this.set("bad-token", "Reader rejected the token — copy it again from Reader's settings.");
      if (st.status !== 200) return this.set("unreachable", `Reader answered ${st.status}.`);
      this.version = (JSON.parse(st.text) as { version?: string }).version ?? "";
      const v = await this.request({ url: this.url("/voices"), method: "GET", headers: this.headers() });
      this.voices = (JSON.parse(v.text) as { voices?: ReaderVoice[] }).voices ?? [];
      return this.set("ok", `Connected to Reader ${this.version} — ${this.voices.length} voices.`);
    } catch {
      this.voices = [];
      return this.set("unreachable", "Reader's voice server isn't running. Open Reader and turn on “Let Talking Cards use my voices”.");
    }
  }

  private set(s: BridgeStatus, msg: string): BridgeStatus {
    this.status = s;
    this.message = msg;
    if (s !== "ok") this.voices = [];
    return s;
  }

  defaultVoice(): ReaderVoice | undefined {
    return this.voices.find((v) => v.default) ?? this.voices.find((v) => v.kind === "system") ?? this.voices[0];
  }

  async synth(text: string, voiceId: string | null, speed: number): Promise<Audio> {
    const r = await this.request({
      url: this.url("/synthesize"),
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ text, voice: voiceId, speed }),
    });
    if (r.status !== 200) {
      let msg = `Reader couldn't speak (${r.status})`;
      try {
        msg = (JSON.parse(r.text) as { error?: string }).error ?? msg;
      } catch {
        // not JSON
      }
      if (r.status === 401) this.set("bad-token", msg);
      throw new Error(msg);
    }
    return decodeWav(r.arrayBuffer);
  }
}

/** PCM WAV (8/16/24/32-bit int or 32-bit float, any channel count) → mono float samples. */
export function decodeWav(buf: ArrayBuffer): Audio {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Reader sent something that isn't a WAV file");
  let o = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (o + 8 <= buf.byteLength) {
    const id = tag(o);
    let size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before format");
      // Some engines write 0 or a too-big size while streaming; trust the file length.
      if (size === 0 || body + size > buf.byteLength) size = buf.byteLength - body;
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * bytes;
          if (fmt.format === 3 && fmt.bits === 32) sum += v.getFloat32(p, true);
          else if (fmt.bits === 16) sum += v.getInt16(p, true) / 32768;
          else if (fmt.bits === 8) sum += (v.getUint8(p) - 128) / 128;
          else if (fmt.bits === 24) sum += (((v.getUint8(p + 2) << 24) | (v.getUint8(p + 1) << 16) | (v.getUint8(p) << 8)) >> 8) / 8388608;
          else if (fmt.bits === 32) sum += v.getInt32(p, true) / 2147483648;
        }
        out[i] = sum / fmt.channels;
      }
      return { samples: out, sampleRate: fmt.rate };
    }
    o = body + size + (size % 2);
  }
  throw new Error("WAV file has no audio");
}
