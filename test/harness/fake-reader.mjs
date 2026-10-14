// Stand-in for Reader's voice server (same protocol), for testing the plugin without a phone.
//   node test/harness/fake-reader.mjs [port] [token]
// Speaks by returning a WAV tone ~60 ms per character. Allows any origin (the real one doesn't).
import http from "node:http";

const port = Number(process.argv[2] ?? 51515);
const token = process.argv[3] ?? "test-token-12345";
const voices = [
  { id: "system:en-gb-x-gba-local", name: "English (United Kingdom) (en-gb-x-gba-local)", lang: "en-GB", kind: "system", default: true },
  { id: "system:es-es-x-eea-local", name: "Spanish (Spain) (es-es-x-eea-local)", lang: "es-ES", kind: "system", default: false },
  { id: "neural:vits-piper-en_GB-alba-medium:0", name: "Alba (Reader)", lang: "en-GB", kind: "neural", default: false },
];

function wav(seconds, rate = 24000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return b;
}

const log = [];
http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": req.headers.origin ?? "*", "Access-Control-Allow-Headers": "Content-Type, X-Reader-Token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (status, obj) => { res.writeHead(status, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.url === "/log") return json(200, log);
  if (req.headers["x-reader-token"] !== token) return json(401, { error: "Missing or wrong token" });
  if (req.url === "/status") return json(200, { app: "Reader", version: "0.5.0-fake", voices: voices.length });
  if (req.url === "/voices") return json(200, { voices });
  if (req.url === "/synthesize" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { text, voice, speed } = JSON.parse(body);
      log.push({ text, voice, speed });
      if (voice && !voices.some((v) => v.id === voice)) return json(404, { error: `Unknown voice: ${voice}` });
      res.writeHead(200, { ...cors, "Content-Type": "audio/wav" });
      res.end(wav((text.length * 0.06) / (speed || 1)));
    });
    return;
  }
  json(404, { error: "Not found" });
}).listen(port, "127.0.0.1", () => console.log(`fake Reader on 127.0.0.1:${port}, token ${token}`));
