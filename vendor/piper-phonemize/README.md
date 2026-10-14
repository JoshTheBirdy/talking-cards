# piper-phonemize (WebAssembly)

From the sherpa-onnx v1.13.8 web TTS release
(`sherpa-onnx-wasm-simd-1.13.8-vits-piper-en_US-libritts_r-medium.tar.bz2`, folder `piper-phonemize/`).

- `phonemize.glue.js` — Emscripten glue (`piper-phonemize-wasm-main.js`), unmodified.
- `phonemize.wasm` — `piper-phonemize-wasm-main.wasm`, unmodified.

Its bundled `.data` (all of espeak-ng-data, 18 MB) is not used: the worker passes an empty
package and writes only the espeak files a voice needs, downloaded per language.

Licences: sherpa-onnx Apache-2.0, piper-phonemize MIT, espeak-ng GPL-3.0.
