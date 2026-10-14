# onnxruntime-web glue

`ort-wasm-simd-threaded.glue.js` is `onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs`
(renamed so the build embeds it as text), with **one patch**:

```diff
- (new URL("ort-wasm-simd-threaded.wasm",import.meta.url)).href
+ "ort-wasm-simd-threaded.wasm"
```

When onnxruntime is given the wasm bytes it doesn't set `locateFile`, and the glue then resolves the
wasm path against its own `blob:` URL, which throws "Invalid URL". The path is never fetched.
`test/vendor.test.ts` checks the patch is in place. The worker serves it to onnxruntime from a blob URL,
because the wasm-only build always imports this file separately. The matching
`ort-wasm-simd-threaded.wasm` is downloaded on first use and checked against its SHA-256
(see `src/tts/piper-engine.ts`). Keep all three in step when upgrading. MIT licence.
