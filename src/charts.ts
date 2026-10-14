// Small HTML charts in Obsidian's theme colours. One hue (the accent) everywhere, so there's
// no categorical palette to get wrong; every chart has hover tips and a table view.

export interface Bar {
  label: string;
  value: number;
  tip: string;
  /** Show this bar's label under the axis (others stay unlabelled to avoid clutter). */
  showLabel?: boolean;
}

function tooltip(container: HTMLElement) {
  container.addClass("tc-chart");
  const tip = container.createDiv({ cls: "tc-tip" });
  return {
    show(target: HTMLElement, text: string) {
      tip.setText(text);
      tip.addClass("is-visible");
      const c = container.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2 - c.left, 60), c.width - 60);
      tip.style.left = `${x}px`;
      tip.style.top = `${r.top - c.top}px`;
    },
    hide() {
      tip.removeClass("is-visible");
    },
  };
}

function table(parent: HTMLElement, headers: [string, string], rows: [string, string][]) {
  const det = parent.createEl("details", { cls: "tc-chart-table" });
  det.createEl("summary", { text: "Table" });
  const t = det.createEl("table");
  const h = t.createEl("thead").createEl("tr");
  for (const x of headers) h.createEl("th", { text: x });
  const b = t.createEl("tbody");
  for (const [a, v] of rows) {
    const tr = b.createEl("tr");
    tr.createEl("td", { text: a });
    tr.createEl("td", { text: v });
  }
}

/** Vertical bars from a shared baseline. */
export function barChart(parent: HTMLElement, title: string, bars: Bar[], headers: [string, string], note?: string) {
  const box = parent.createDiv({ cls: "tc-chart-box" });
  const head = box.createDiv({ cls: "tc-chart-head" });
  head.createDiv({ cls: "tc-chart-title", text: title });
  if (note) head.createDiv({ cls: "tc-chart-note", text: note });
  const max = Math.max(1, ...bars.map((b) => b.value));
  const plot = box.createDiv({ cls: "tc-bars" });
  const tips = tooltip(plot);
  plot.createDiv({ cls: "tc-bars-max", text: String(max) });
  const row = plot.createDiv({ cls: "tc-bars-row" });
  for (const b of bars) {
    const col = row.createDiv({ cls: "tc-bar-col" });
    const bar = col.createDiv({ cls: "tc-bar" });
    bar.style.height = b.value ? `max(2px, ${(b.value / max) * 100}%)` : "0";
    col.onpointerenter = () => tips.show(bar.offsetHeight ? bar : col, b.tip);
    col.onpointerleave = () => tips.hide();
  }
  const labels = box.createDiv({ cls: "tc-bars-labels" });
  for (const b of bars) labels.createDiv({ cls: "tc-bar-label", text: b.showLabel ? b.label : "" });
  table(box, headers, bars.map((b) => [b.label, String(b.value)]));
}

/** Horizontal labelled bars, for a handful of categories. */
export function barList(parent: HTMLElement, title: string, rows: { label: string; value: number }[]) {
  const box = parent.createDiv({ cls: "tc-chart-box" });
  box.createDiv({ cls: "tc-chart-title", text: title });
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((n, r) => n + r.value, 0);
  for (const r of rows) {
    const line = box.createDiv({ cls: "tc-hbar-row" });
    line.createDiv({ cls: "tc-hbar-label", text: r.label });
    const track = line.createDiv({ cls: "tc-hbar-track" });
    const fill = track.createDiv({ cls: "tc-hbar" });
    fill.style.width = r.value ? `max(2px, ${(r.value / max) * 100}%)` : "0";
    const pct = total ? (r.value / total) * 100 : 0;
    const shown = r.value && pct < 1 ? "<1" : String(Math.round(pct));
    line.createDiv({ cls: "tc-hbar-value", text: `${r.value} (${shown}%)` });
  }
}

/** GitHub-style year of days; one hue, four steps. Scrolls to today on narrow screens. */
export function heatmap(parent: HTMLElement, title: string, days: { key: string; date: Date; count: number; tip: string }[], note?: string) {
  const box = parent.createDiv({ cls: "tc-chart-box" });
  const head = box.createDiv({ cls: "tc-chart-head" });
  head.createDiv({ cls: "tc-chart-title", text: title });
  if (note) head.createDiv({ cls: "tc-chart-note", text: note });
  const scroller = box.createDiv({ cls: "tc-heat-scroll" });
  const grid = scroller.createDiv({ cls: "tc-heat" });
  const tips = tooltip(scroller);
  const max = Math.max(1, ...days.map((d) => d.count));
  // Start the first column on Monday.
  const lead = (days[0].date.getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) grid.createDiv({ cls: "tc-heat-cell is-blank" });
  for (const d of days) {
    const level = d.count ? Math.min(4, Math.ceil((d.count / max) * 4)) : 0;
    const cell = grid.createDiv({ cls: `tc-heat-cell tc-heat-${level}` });
    cell.onpointerenter = () => tips.show(cell, d.tip);
    cell.onpointerleave = () => tips.hide();
  }
  const legend = box.createDiv({ cls: "tc-heat-legend" });
  legend.createSpan({ text: "Less" });
  for (let l = 0; l <= 4; l++) legend.createDiv({ cls: `tc-heat-cell tc-heat-${l}` });
  legend.createSpan({ text: "More" });
  window.requestAnimationFrame(() => (scroller.scrollLeft = scroller.scrollWidth));
  table(box, ["Day", "Reviews"], days.filter((d) => d.count).reverse().map((d) => [d.key, String(d.count)]));
}

/** A big number with a caption. */
export function statTile(parent: HTMLElement, label: string, value: string, sub?: string) {
  const s = parent.createDiv({ cls: "tc-stat" });
  s.createDiv({ cls: "tc-stat-value tc-hero", text: value });
  s.createDiv({ cls: "tc-stat-label", text: label });
  if (sub) s.createDiv({ cls: "tc-stat-sub", text: sub });
}
