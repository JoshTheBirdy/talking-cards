// Installs the built plugin into the vault currently open in Obsidian on the phone, by having
// Obsidian write the files itself (works for vaults in the app's private folder, unlike adb push).
//   node scripts/phone-install.mjs [settings.json]   (after scripts/phone-cdp.sh)
//   FILES=dir/ node scripts/phone-install.mjs          installs main.js etc. from dir/ (e.g. a downloaded release)
import { readFileSync } from "node:fs";
const root = process.env.FILES ? process.env.FILES.replace(/\/?$/, "/") : new URL("../", import.meta.url).pathname;
const files = Object.fromEntries(["main.js", "manifest.json", "styles.css"].map((f) => [f, readFileSync(root + f, "utf8")]));
const settings = process.argv[2] ? readFileSync(process.argv[2], "utf8") : null;
const expr = `(async () => {
  const dir = app.vault.configDir + "/plugins/talking-cards";
  if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
  const files = ${JSON.stringify(files)};
  for (const [name, text] of Object.entries(files)) await app.vault.adapter.write(dir + "/" + name, text);
  const settings = ${JSON.stringify(settings)};
  if (settings && !(await app.vault.adapter.exists(dir + "/data.json"))) await app.vault.adapter.write(dir + "/data.json", settings);
  if (app.plugins.plugins["talking-cards"]) await app.plugins.disablePlugin("talking-cards");
  await app.plugins.loadManifests();
  await app.plugins.enablePluginAndSave("talking-cards");
  return { vault: app.vault.getName(), restricted: !app.plugins.isEnabled(), loaded: !!app.plugins.plugins["talking-cards"] };
})()`;
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id !== 1) return;
  console.log(JSON.stringify(d.result.result?.value ?? d.result.exceptionDetails?.exception?.description));
  process.exit(0);
};
