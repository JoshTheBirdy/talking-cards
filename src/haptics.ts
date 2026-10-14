// A short tick when a swipe arms. Obsidian mobile ships Capacitor's Haptics plugin; elsewhere
// navigator.vibrate if it exists. Fails quietly.
interface HapticsPlugin {
  impact(o: { style: "LIGHT" | "MEDIUM" | "HEAVY" }): Promise<void>;
}

export function tick() {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    const h = cap?.Plugins?.Haptics as HapticsPlugin | undefined;
    if (h) void h.impact({ style: "LIGHT" }).catch(() => {});
    else navigator.vibrate?.(8);
  } catch {
    // no haptics
  }
}
