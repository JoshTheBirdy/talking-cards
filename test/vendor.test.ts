import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("onnxruntime glue carries the blob-URL patch (see vendor/onnxruntime/README.md)", () => {
  const glue = readFileSync(new URL("../vendor/onnxruntime/ort-wasm-simd-threaded.glue.js", import.meta.url), "utf8");
  assert.ok(!glue.includes('new URL("ort-wasm-simd-threaded.wasm",import.meta.url)'));
});

test("vendored onnxruntime matches the installed package version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../node_modules/onnxruntime-web/package.json", import.meta.url), "utf8"));
  const core = readFileSync(new URL("../src/tts/piper-core.ts", import.meta.url), "utf8");
  assert.ok(core.includes(`onnxruntime-web@${pkg.version} `), `piper-core.ts should name onnxruntime-web@${pkg.version}`);
});
