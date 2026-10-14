import esbuild from "esbuild";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

// The TTS worker (onnxruntime + piper-phonemize) is built separately and embedded in main.js
// as a string, so Obsidian only parses it when a voice is first used.
const workerSource = {
  name: "worker-source",
  setup(build) {
    build.onResolve({ filter: /^tts-worker-source$/ }, () => ({ path: "tts-worker-source", namespace: "worker" }));
    build.onLoad({ filter: /.*/, namespace: "worker" }, async () => {
      const out = await esbuild.build({
        entryPoints: ["src/tts/worker.ts"],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: prod,
        loader: { ".wasm": "binary", ".glue.js": "text" },
        logLevel: "warning",
        // onnxruntime's bundle mentions import.meta.url; we hand it the wasm bytes instead.
        define: { "import.meta.url": '""' },
      });
      return { contents: out.outputFiles[0].text, loader: "text", watchFiles: ["src/tts/worker.ts", "src/tts/piper-core.ts"] };
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  outfile: "main.js",
  plugins: [workerSource],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
