import { Modal, Notice, TFile, setIcon, type App } from "obsidian";
import type TalkingCards from "./main.ts";
import { plainText } from "./speech-text.ts";
import { isLeech, stateName } from "./stats.ts";
import { formatInterval, isNew } from "./scheduler.ts";
import type { Card } from "./parser.ts";
import { LostCardModal } from "./edit-tracker.ts";

type Row = Card & { path: string; deck: string };
type Filter = "all" | "new" | "learning" | "review" | "due" | "suspended" | "leech";
type SortKey = "note" | "due" | "interval" | "lapses" | "difficulty";

const PAGE = 150;
const DAY = 86400_000;

/** The Browse tab: search, filter and act on cards. Lives as long as the dashboard view. */
export class CardBrowser {
  query = "";
  deck = "";
  filter: Filter = "all";
  sort: SortKey = "note";
  desc = false;
  limit = PAGE;
  selected = new Set<string>();
  private tableEl: HTMLElement | null = null;
  private barEl: HTMLElement | null = null;

  constructor(private plugin: TalkingCards) {}

  /** Builds controls once; `refresh` redraws only the list so the search box keeps focus. */
  mount(el: HTMLElement, decks: string[]) {
    const controls = el.createDiv({ cls: "tc-browse-controls" });
    const search = controls.createEl("input", { type: "search", placeholder: "Search cards…", value: this.query });
    search.oninput = () => {
      this.query = search.value;
      this.limit = PAGE;
      this.refresh();
    };
    const deckSel = controls.createEl("select", { cls: "dropdown" });
    deckSel.createEl("option", { value: "", text: "All decks" });
    for (const d of decks) deckSel.createEl("option", { value: d, text: d || "(vault root)" });
    deckSel.value = this.deck;
    deckSel.onchange = () => {
      this.deck = deckSel.value;
      this.refresh();
    };
    const filt = controls.createEl("select", { cls: "dropdown" });
    for (const [v, t] of [["all", "All cards"], ["due", "Due today"], ["new", "New"], ["learning", "Learning"], ["review", "Review"], ["suspended", "Suspended"], ["leech", "Leeches"]] as const) {
      filt.createEl("option", { value: v, text: t });
    }
    filt.value = this.filter;
    filt.onchange = () => {
      this.filter = filt.value as Filter;
      this.refresh();
    };
    this.barEl = el.createDiv({ cls: "tc-browse-bar" });
    this.tableEl = el.createDiv({ cls: "tc-browse-list" });
    this.refresh();
  }

  private rows(): Row[] {
    const { index, store, settings } = this.plugin;
    const now = Date.now();
    const eod = now + DAY;
    const q = this.query.toLowerCase().trim();
    const rows = index.allCards().filter((c) => {
      if (this.deck && c.deck !== this.deck && !c.deck.startsWith(this.deck + "/")) return false;
      const st = store.state(c.key);
      switch (this.filter) {
        case "new": if (!isNew(st) || st?.suspended) return false; break;
        case "learning": if (!["Learning", "Relearning"].includes(stateName(st))) return false; break;
        case "review": if (!["Young", "Mature"].includes(stateName(st))) return false; break;
        case "due": if (!st || isNew(st) || st.suspended || +st.fsrs.due > eod) return false; break;
        case "suspended": if (!st?.suspended) return false; break;
        case "leech": if (!isLeech(st, settings.leechThreshold)) return false; break;
      }
      return !q || `${c.front}\n${c.back}\n${c.path}`.toLowerCase().includes(q);
    });
    const val = (c: Row): number | string => {
      const st = store.state(c.key);
      switch (this.sort) {
        case "note": return c.path;
        case "due": return st && !isNew(st) ? +st.fsrs.due : Infinity;
        case "interval": return st?.fsrs.scheduled_days ?? -1;
        case "lapses": return st?.fsrs.lapses ?? 0;
        case "difficulty": return st && !isNew(st) ? st.fsrs.difficulty : -1;
      }
    };
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      const r = x < y ? -1 : x > y ? 1 : 0;
      return this.desc ? -r : r;
    });
    return rows;
  }

  refresh() {
    const el = this.tableEl;
    if (!el) return;
    el.empty();
    const rows = this.rows();
    const keys = new Set(rows.map((r) => r.key));
    for (const k of this.selected) if (!keys.has(k)) this.selected.delete(k);
    this.renderBar(rows);

    if (!rows.length) {
      el.createEl("p", { cls: "tc-muted", text: "No cards match." });
      return;
    }
    const table = el.createEl("table", { cls: "tc-table" });
    const head = table.createEl("thead").createEl("tr");
    const all = head.createEl("th", { cls: "tc-col-check" }).createEl("input", { type: "checkbox" });
    all.checked = rows.slice(0, this.limit).every((r) => this.selected.has(r.key));
    all.onchange = () => {
      for (const r of rows.slice(0, this.limit)) all.checked ? this.selected.add(r.key) : this.selected.delete(r.key);
      this.refresh();
    };
    const col = (label: string, key: SortKey | null, cls = "") => {
      const th = head.createEl("th", { cls, text: label });
      if (!key) return;
      th.addClass("tc-sortable");
      if (this.sort === key) th.setText(`${label} ${this.desc ? "↓" : "↑"}`);
      th.onclick = () => {
        this.desc = this.sort === key ? !this.desc : false;
        this.sort = key;
        this.refresh();
      };
    };
    col("Question", null);
    col("Answer", null, "tc-col-wide");
    col("Note", "note", "tc-col-wide");
    col("State", null);
    col("Due", "due");
    col("Interval", "interval", "tc-col-wide");
    col("Lapses", "lapses", "tc-col-wide");
    col("Diff.", "difficulty", "tc-col-wide");

    const body = table.createEl("tbody");
    const now = Date.now();
    for (const r of rows.slice(0, this.limit)) {
      const st = this.plugin.store.state(r.key);
      const tr = body.createEl("tr", { cls: this.selected.has(r.key) ? "is-selected" : "" });
      const cb = tr.createEl("td", { cls: "tc-col-check" }).createEl("input", { type: "checkbox" });
      cb.checked = this.selected.has(r.key);
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        cb.checked ? this.selected.add(r.key) : this.selected.delete(r.key);
        tr.toggleClass("is-selected", cb.checked);
        this.renderBar(rows);
      };
      tr.createEl("td", { cls: "tc-cell-text", text: plainText(r.front) });
      tr.createEl("td", { cls: "tc-cell-text tc-col-wide", text: plainText(r.back) });
      tr.createEl("td", { cls: "tc-cell-note tc-col-wide", text: r.path.replace(/\.md$/, "").split("/").pop()! });
      const name = stateName(st);
      const stateTd = tr.createEl("td");
      stateTd.createSpan({ cls: `tc-chip tc-chip-${name.toLowerCase()}`, text: name });
      if (isLeech(st, this.plugin.settings.leechThreshold)) stateTd.createSpan({ cls: "tc-chip tc-chip-leech", text: "Leech" });
      tr.createEl("td", { cls: "tc-col-due", text: st && !isNew(st) && !st.suspended ? relDue(+st.fsrs.due - now) : "—" });
      tr.createEl("td", { cls: "tc-col-wide", text: st && !isNew(st) ? (st.fsrs.scheduled_days ? `${st.fsrs.scheduled_days}d` : "<1d") : "—" });
      tr.createEl("td", { cls: "tc-col-wide", text: st ? String(st.fsrs.lapses) : "0" });
      tr.createEl("td", { cls: "tc-col-wide", text: st && !isNew(st) ? st.fsrs.difficulty.toFixed(1) : "—" });
      tr.onclick = () => this.open(r);
    }
    if (rows.length > this.limit) {
      const more = el.createEl("button", { cls: "tc-more", text: `Show more (${rows.length - this.limit} left)` });
      more.onclick = () => {
        this.limit += PAGE;
        this.refresh();
      };
    }
  }

  private renderBar(rows: Row[]) {
    const bar = this.barEl;
    if (!bar) return;
    bar.empty();
    const n = this.selected.size;
    bar.createSpan({ cls: "tc-muted", text: n ? `${n} selected` : `${rows.length} card${rows.length === 1 ? "" : "s"}` });
    if (!n) return;
    const keys = [...this.selected];
    const act = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl("button", { attr: { "aria-label": label } });
      setIcon(b.createSpan(), icon);
      b.createSpan({ text: label });
      b.onclick = fn;
    };
    act("pause", "Suspend", () => this.apply(keys, "suspend"));
    act("play", "Unsuspend", () => this.apply(keys, "unsuspend"));
    act("rotate-ccw", "Reset", () =>
      new ConfirmModal(this.plugin.app, `Reset ${n} card${n === 1 ? "" : "s"}?`, "They become new again. Their review history stays in the log but no longer counts.", () =>
        this.apply(keys, "reset"),
      ).open(),
    );
    if (n === 1)
      act("git-merge", "Take progress from…", () =>
        new LostCardModal(this.plugin.app, this.plugin.edits.lost, (lost) => {
          this.plugin.edits.merge(lost, keys[0].split("#")[0]);
          new Notice("Progress moved to this card");
          this.selected.clear();
          this.refresh();
        }).open(),
      );
    act("x", "Clear", () => {
      this.selected.clear();
      this.refresh();
    });
  }

  private apply(keys: string[], a: "suspend" | "unsuspend" | "reset") {
    const t = Date.now();
    this.plugin.store.addMany(keys.map((k) => ({ t, k, a })));
    new Notice(`${a === "reset" ? "Reset" : a === "suspend" ? "Suspended" : "Unsuspended"} ${keys.length} card${keys.length === 1 ? "" : "s"}`);
    this.selected.clear();
    this.refresh();
  }

  private async open(r: Row) {
    const file = this.plugin.app.vault.getAbstractFileByPath(r.path);
    if (!(file instanceof TFile)) return;
    const block = this.plugin.index.notes.get(r.path)?.blocks.find((b) => b.id === r.blockId);
    await this.plugin.app.workspace.getLeaf("tab").openFile(file, { eState: { line: block?.firstLine ?? 0 } });
  }
}

function relDue(ms: number): string {
  if (ms <= 0) return ms > -DAY ? "now" : `${formatInterval(-ms)} overdue`;
  return `in ${formatInterval(ms)}`;
}

class ConfirmModal extends Modal {
  constructor(app: App, private title: string, private body: string, private yes: () => void) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.body });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = row.createEl("button", { cls: "mod-warning", text: "Reset" });
    ok.onclick = () => {
      this.yes();
      this.close();
    };
  }
}
