// Evaluates JS in the phone's Obsidian (after scripts/phone-cdp.sh). The code runs inside an
// async function, so `await` and `return` work.
//   node scripts/cdp-eval.mjs 'return app.vault.getName()'
const expr = process.argv[2];
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = pages.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () =>
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true } }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id !== 1) return;
  const r = d.result;
  if (r.exceptionDetails) console.error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  else console.log(typeof r.result.value === "string" ? r.result.value : JSON.stringify(r.result.value, null, 1));
  ws.close();
  process.exit(r.exceptionDetails ? 1 : 0);
};
setTimeout(() => (console.error("timeout"), process.exit(1)), 120_000);
