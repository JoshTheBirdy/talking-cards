// Runs the real plugin against obsidian-mock.ts in a browser page. See README.md here.
import { App } from "obsidian";
import TalkingCards from "../../src/main.ts";

declare const VAULT: Record<string, string>;
const params = new URLSearchParams(location.search);
if (params.has("dark")) document.body.classList.add("theme-dark");
if (params.has("reset")) {
  localStorage.clear();
  indexedDB.deleteDatabase("talking-cards-harness-x");
}

const app = new App();
app.vault.seed(VAULT);
const plugin = new (TalkingCards as unknown as new (a: App) => TalkingCards)(app);
(window as any).app = app;
// Look like Obsidian's plugin registry, so scripts/phone-checks.mjs can dry-run against the harness.
(app as any).plugins = { plugins: { "talking-cards": plugin }, manifests: { "talking-cards": { version: "harness" } } };
if (params.get("vault")) app.vault.getName = () => params.get("vault")!;
(window as any).plugin = plugin;

(async () => {
  await plugin.onload();
  await new Promise((r) => setTimeout(r, 50));
  if (params.has("history")) await seedHistory();
  (window as any).__ready = true;
})();

/** Simulated months of reviews so stats, due counts and the browser have something to show. */
async function seedHistory() {
  const p = plugin as any;
  await p.ensureIds([...p.index.notes.keys()]);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const D = 86400_000;
  const now = Date.now();
  const cards = p.index.allCards();
  cards.forEach((c: { key: string }, i: number) => {
    if (i % 4 === 3) return; // leave some new
    let t = now - (60 - i) * D;
    for (let n = 0; n < 6 && t < now - D / 2; n++) {
      const r = rnd() < 0.15 ? 1 : rnd() < 0.85 ? 3 : 4;
      p.store.add({ t, k: c.key, r, ms: 3000 + rnd() * 6000 });
      t += (n + 1) * (2 + rnd() * 6) * D;
    }
  });
  await p.store.save();
}
