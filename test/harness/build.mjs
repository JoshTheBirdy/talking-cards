// Bundles the plugin with the fake Obsidian API into dist/harness.js.
import esbuild from "esbuild";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const vaultDir = join(root, "test-vault");
const vault = {};
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (f.startsWith(".")) continue;
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".md")) vault[relative(vaultDir, p)] = readFileSync(p, "utf8");
    else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f)) vault[relative(vaultDir, p)] = ""; // served from test-vault/ by the http server
  }
};
walk(vaultDir);

const workerSource = {
  name: "worker-source",
  setup(b) {
    b.onResolve({ filter: /^tts-worker-source$/ }, () => ({ path: "w", namespace: "worker" }));
    b.onLoad({ filter: /.*/, namespace: "worker" }, async () => {
      const o = await esbuild.build({
        entryPoints: [join(root, "src/tts/worker.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
        loader: { ".wasm": "binary", ".glue.js": "text" }, define: { "import.meta.url": '""' }, logLevel: "warning",
      });
      return { contents: o.outputFiles[0].text, loader: "text" };
    });
  },
};

await esbuild.build({
  entryPoints: [join(here, "harness.ts")],
  bundle: true,
  outfile: join(here, "dist/harness.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  alias: { obsidian: join(here, "obsidian-mock.ts") },
  define: { VAULT: JSON.stringify(vault) },
  plugins: [workerSource],
  sourcemap: "inline",
  logLevel: "warning",
});
console.log(`harness built with ${Object.keys(vault).length} notes`);
