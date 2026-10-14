// Keeps the screen on during audio mode. Obsidian mobile ships Capacitor's KeepAwake plugin
// (seen on Android); desktops get the Screen Wake Lock API. Both fail quietly.

interface KeepAwakePlugin {
  keepAwake(): Promise<void>;
  allowSleep(): Promise<void>;
}

let sentinel: WakeLockSentinel | null = null;
let held = false;

function capacitor(): KeepAwakePlugin | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  return (cap?.Plugins?.KeepAwake as KeepAwakePlugin | undefined) ?? null;
}

export async function keepAwake() {
  held = true;
  try {
    const ka = capacitor();
    if (ka) return await ka.keepAwake();
    if ("wakeLock" in navigator && !sentinel) sentinel = await navigator.wakeLock.request("screen");
  } catch (e) {
    console.debug("Talking Cards: keep-awake unavailable", e);
  }
}

export async function allowSleep() {
  held = false;
  try {
    const ka = capacitor();
    if (ka) return await ka.allowSleep();
    await sentinel?.release();
  } catch {
    // ignore
  }
  sentinel = null;
}

// A wake lock is dropped when the window is hidden; take it again on return.
document.addEventListener("visibilitychange", () => {
  if (held && document.visibilityState === "visible" && !capacitor()) {
    sentinel = null;
    void keepAwake();
  }
});
