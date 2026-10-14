import { test } from "node:test";
import assert from "node:assert/strict";
import { ReaderBridge, decodeWav, type Requester } from "../src/tts/reader-bridge.ts";

function wav16(samples: number[], rate = 24000, channels = 1): ArrayBuffer {
  const data = samples.length * 2;
  const b = new DataView(new ArrayBuffer(44 + data));
  const w = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); b.setUint32(4, 36 + data, true); w(8, "WAVE");
  w(12, "fmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, channels, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 2 * channels, true); b.setUint16(32, 2 * channels, true); b.setUint16(34, 16, true);
  w(36, "data"); b.setUint32(40, data, true);
  samples.forEach((s, i) => b.setInt16(44 + i * 2, s, true));
  return b.buffer;
}

test("decodeWav: 16-bit mono and stereo", () => {
  const a = decodeWav(wav16([0, 16384, -32768]));
  assert.equal(a.sampleRate, 24000);
  assert.deepEqual([...a.samples], [0, 0.5, -1]);
  const s = decodeWav(wav16([16384, 0, -16384, -16384], 22050, 2));
  assert.deepEqual([...s.samples], [0.25, -0.5]);
  assert.throws(() => decodeWav(new ArrayBuffer(10)));
});

test("decodeWav tolerates a zero data size (streamed files)", () => {
  const buf = wav16([100, 200]);
  new DataView(buf).setUint32(40, 0, true);
  assert.equal(decodeWav(buf).samples.length, 2);
});

function fakeReader(token: string): Requester {
  const enc = new TextEncoder();
  return async ({ url, method, headers, body }) => {
    const reply = (status: number, obj: unknown) => ({ status, text: JSON.stringify(obj), arrayBuffer: enc.encode(JSON.stringify(obj)).buffer });
    if (headers["X-Reader-Token"] !== token) return reply(401, { error: "Missing or wrong token" });
    const path = new URL(url).pathname;
    if (path === "/status") return reply(200, { app: "Reader", version: "0.5.0", voices: 2 });
    if (path === "/voices") return reply(200, { voices: [
      { id: "neural:alba:0", name: "Alba (Reader)", lang: "en-GB", kind: "neural", default: false },
      { id: "system:en-gb-x-gba-local", name: "English (UK)", lang: "en-GB", kind: "system", default: true },
    ] });
    if (path === "/synthesize" && method === "POST") {
      const { text } = JSON.parse(body!);
      return { status: 200, text: "", arrayBuffer: wav16(new Array(text.length * 10).fill(1000)) };
    }
    return reply(404, { error: "Not found" });
  };
}

test("check: no token, wrong token, connected", async () => {
  let token = "";
  const b = new ReaderBridge(fakeReader("tok"), () => ({ token, port: 51515 }));
  assert.equal(await b.check(), "no-token");
  token = "nope";
  assert.equal(await b.check(), "bad-token");
  token = "tok";
  assert.equal(await b.check(), "ok");
  assert.equal(b.voices.length, 2);
  assert.equal(b.defaultVoice()!.id, "system:en-gb-x-gba-local");
  const a = await b.synth("hello", null, 1);
  assert.equal(a.samples.length, 50);
});

test("unreachable when the request throws", async () => {
  const b = new ReaderBridge(async () => { throw new Error("ECONNREFUSED"); }, () => ({ token: "t", port: 1 }));
  assert.equal(await b.check(), "unreachable");
  assert.match(b.message, /Reader/);
});
