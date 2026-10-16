// esbuild plugin: `import gz from "ort-wasm-gz"` gives onnxruntime's WebAssembly engine, gzipped and
// base64-encoded, so it ships inside main.js. (Obsidian plugins may not download code at runtime.)
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// The package's exports map hides dist/; read it from node_modules directly.
const file = fileURLToPath(new URL("../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", import.meta.url));

export const ortWasm = {
  name: "ort-wasm-gz",
  setup(build) {
    build.onResolve({ filter: /^ort-wasm-gz$/ }, () => ({ path: "ort-wasm-gz", namespace: "ort-wasm" }));
    build.onLoad({ filter: /.*/, namespace: "ort-wasm" }, () => {
      const gz = gzipSync(readFileSync(file), { level: 9 });
      return { contents: gz.toString("base64"), loader: "text", watchFiles: [file] };
    });
  },
};
