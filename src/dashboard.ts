import { ItemView, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type TalkingCards from "./main.ts";
import { deckTree, type DeckNode } from "./index.ts";
import { streak } from "./scheduler.ts";
import { CardBrowser } from "./browse.ts";
import { renderStats } from "./stats-view.ts";

type Tab = "overview" | "browse" | "stats";

export const DASHBOARD_VIEW = "talking-cards-dashboard";

/** Ribbon button target: today's numbers and the deck tree. Stats/browse tabs arrive with M6. */
export class DashboardView extends ItemView {
  /** Folder open in the deck browser ("" = top). */
  private deckPath = "";
  private renderQueued = false;
  private tab: Tab = "overview";
  private statsDeck = "";
  private statsToken = 0;
  private browser: CardBrowser;

  constructor(leaf: WorkspaceLeaf, private plugin: TalkingCards) {
    super(leaf);
    this.browser = new CardBrowser(plugin);
  }

  getState() {
    return { tab: this.tab, deck: this.deckPath };
  }

  async setState(state: { tab?: Tab; deck?: string }, result: ViewStateResult) {
    if (state?.tab) this.tab = state.tab;
    if (typeof state?.deck === "string") this.deckPath = state.deck;
    await super.setState(state, result);
    this.render();
  }

  /** Opens a tab, optionally pre-filtering the browser. */
  show(tab: Tab, browse?: { deck?: string; query?: string }) {
    this.tab = tab;
    if (browse) {
      this.browser.deck = browse.deck ?? "";
      this.browser.query = browse.query ?? "";
    }
    this.render();
  }

  getViewType() {
    return DASHBOARD_VIEW;
  }
  getDisplayText() {
    return "Talking Cards";
  }
  getIcon() {
    return "layers";
  }

  async onOpen() {
    const s = this.plugin.settings;
    // Someone who reads aloud will likely study next: start the voice engine now.
    if (s.autoReadFront || s.autoReadBack || this.app.loadLocalStorage("talking-cards-audio-mode") === true) this.plugin.tts.warm();
    this.registerEvent(this.plugin.index.on("changed", () => this.queueRender()));
    this.registerEvent(this.plugin.store.on("changed", () => this.queueRender()));
    this.render();
  }

  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    window.setTimeout(() => {
      this.renderQueued = false;
      // Browsing: redraw the list only, so the search box keeps focus.
      if (this.tab === "browse") this.browser.refresh();
      else this.render();
    }, 200);
  }

  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("tc-dashboard");
    if (!this.plugin.index.ready) {
      el.createEl("p", { text: "Scanning notes for cards…", cls: "tc-muted" });
      return;
    }
    const tabs = el.createDiv({ cls: "tc-tabs" });
    for (const [t, label] of [["overview", "Overview"], ["browse", "Browse"], ["stats", "Stats"]] as const) {
      const b = tabs.createEl("button", { cls: `tc-tab${this.tab === t ? " is-active" : ""}`, text: label });
      b.onclick = () => {
        this.tab = t;
        this.render();
      };
    }
    const body = el.createDiv({ cls: "tc-tab-body" });
    const decks = this.deckPaths();
    if (this.tab === "browse") return this.browser.mount(body, decks);
    if (this.tab === "stats") {
      const row = body.createDiv({ cls: "tc-browse-controls" });
      const sel = row.createEl("select", { cls: "dropdown" });
      sel.createEl("option", { value: "", text: "All decks" });
      for (const d of decks) sel.createEl("option", { value: d, text: d || "(vault root)" });
      sel.value = this.statsDeck;
      sel.onchange = () => {
        this.statsDeck = sel.value;
        this.render();
      };
      // Replaying a long history takes a moment on phones; let the tab paint first.
      const wait = body.createEl("p", { cls: "tc-muted", text: "Calculating…" });
      const token = ++this.statsToken;
      window.setTimeout(() => {
        if (token !== this.statsToken || this.tab !== "stats") return;
        wait.remove();
        renderStats(body, this.plugin, this.statsDeck);
      }, 30);
      return;
    }
    this.renderOverview(body);
  }

  private deckPaths(): string[] {
    const out: string[] = [];
    const walk = (n: DeckNode) => n.children.forEach((c) => (out.push(c.path), walk(c)));
    walk(deckTree(this.plugin.index, this.plugin.settings.dedupe));
    return out;
  }

  private renderOverview(el: HTMLElement) {
    const { index, store, settings } = this.plugin;
    const root = deckTree(index, this.plugin.settings.dedupe);
    const all = index.allCards();
    const now = Date.now();
    const total = this.plugin.counts(all);
    const today = store.today(now);

    // Today's numbers for the whole vault: only at the top level, so a folder's own list gets the room.
    const top = el.createDiv();
    const strip = top.createDiv({ cls: "tc-strip" });
    stat(strip, "Due", total.due, "tc-count-due");
    stat(strip, "New", total.new, "tc-count-new");
    stat(strip, "Studied today", today.newToday + today.reviewsToday);
    stat(strip, "Day streak", streak(store.entries, now, settings.dayStartHour));
    stat(strip, "Cards", all.length);

    // Switched-off cards aren't studied, but they still exist: the folder list (and its switches)
    // must stay, or there'd be no way to switch anything back on.
    const exists = all.length > 0 || index.cardsIn({ kind: "all", value: "" }, true).length > 0;
    const label = !all.length && exists ? "Everything is switched off" : total.due + total.new ? "Study all due cards" : "All done for today";
    const go = top.createEl("button", { cls: "mod-cta tc-study-all", text: label });
    go.disabled = !(total.due + total.new);
    go.onclick = () => void this.plugin.study({ kind: "all", value: "" }, this.leaf);

    if (!exists) {
      el.createEl("p", { cls: "tc-muted", text: "No cards yet. Write one in any note: Question ;; Answer" });
      return;
    }
    if (!this.renderFolder(el, root, all)) top.remove();
  }

  /** One folder level, like a file explorer: breadcrumb, this deck, its sub-decks, its notes. */
  /** Returns true when showing the top level (after skipping single-folder chains). */
  private renderFolder(el: HTMLElement, root: DeckNode, all: IndexedCards): boolean {
    // Find the open folder; fall back to the top if it vanished (renamed, emptied).
    const trail: DeckNode[] = [root];
    for (const part of this.deckPath ? this.deckPath.split("/") : []) {
      const next = trail[trail.length - 1].children.find((c) => c.name === part);
      if (!next) break;
      trail.push(next);
    }
    // Skip folders that only hold one folder (Notes › School › …).
    let node = trail[trail.length - 1];
    while (node.children.length === 1 && !this.directNotes(node.path).length) {
      node = node.children[0];
      trail.push(node);
    }
    this.deckPath = node.path;
    let topNode = root;
    while (topNode.children.length === 1 && !this.directNotes(topNode.path).length) topNode = topNode.children[0];
    const isTop = node === topNode;
    const index = this.plugin.index;
    const deckCards = (path: string) => index.cardsIn({ kind: "deck", value: path });

    const nav = el.createDiv({ cls: "tc-crumbs" });
    if (trail.length === 1) nav.hide();
    const skips = (n: DeckNode) => n.children.length === 1 && !this.directNotes(n.path).length;
    // Ancestors only: the open folder's name heads the card below.
    trail.slice(0, -1).forEach((n, i) => {
      if (i) setIcon(nav.createSpan({ cls: "tc-crumb-sep" }), "chevron-right");
      // A folder that only holds one folder would open straight back here: plain text, not a link.
      const link = !skips(n);
      const b = nav.createEl(link ? "button" : "span", { cls: `tc-crumb${link ? "" : " is-plain"}`, text: i ? n.name : "All decks" });
      if (link) b.onclick = () => this.openFolder(n.path);
    });

    // This deck: what's waiting, and one button to study it.
    if (node !== root) {
      const cards = deckCards(node.path);
      const c = this.plugin.counts(cards);
      const on = index.isActive(node.path);
      const head = el.createDiv({ cls: `tc-folder-head${on ? "" : " is-inactive"}` });
      const info = head.createDiv({ cls: "tc-folder-info" });
      info.createDiv({ cls: "tc-folder-title", text: node.name });
      counts(info, c, cards.length, on);
      this.activeSwitch(head, node.path, node.name);
      const btn = head.createEl("button", { cls: "mod-cta", text: "Study" });
      btn.disabled = !(c.new + c.due);
      btn.onclick = () => void this.plugin.study({ kind: "deck", value: node.path }, this.leaf);
    }

    if (node.children.length) {
      el.createDiv({ cls: "tc-section-label", text: node === root ? "Decks" : "Sub-decks" });
      const list = el.createDiv({ cls: "tc-list" });
      for (const child of node.children) {
        // Merge single-folder chains into one row: "School / Year 2".
        let target = child;
        const inner: string[] = [];
        while (target.children.length === 1 && !this.directNotes(target.path).length) {
          target = target.children[0];
          inner.push(target.name);
        }
        const label: string | [string, string] = inner.length ? [child.name, inner.join(" / ")] : child.name;
        const cards = deckCards(target.path);
        this.row(list, "folder", target.path, label, cards, () => this.openFolder(target.path), () =>
          void this.plugin.study({ kind: "deck", value: target.path }, this.leaf),
        );
      }
    }

    const notes = this.directNotes(node.path);
    if (notes.length) {
      el.createDiv({ cls: "tc-section-label", text: "Notes" });
      const list = el.createDiv({ cls: "tc-list" });
      for (const n of notes) {
        const cards = index.cardsIn({ kind: "note", value: n.path });
        if (!cards.length) continue;
        const name = n.path.split("/").pop()!.replace(/\.md$/, "");
        const study = () => void this.plugin.study({ kind: "note", value: n.path }, this.leaf);
        this.row(list, "file-text", n.path, name, cards, study, study);
      }
    }
    return isTop;
  }

  /** Notes filed directly in a folder ("" = vault root), by name. */
  private directNotes(path: string) {
    return [...this.plugin.index.notes.values()].filter((n) => n.deck === path).sort((a, b) => a.path.localeCompare(b.path));
  }

  private openFolder(path: string) {
    this.deckPath = path;
    this.render();
    this.contentEl.scrollTop = 0;
  }

  /**
   * The on/off switch for studying: off leaves this folder or note (and everything in it) out of
   * "Study all". Stored in the vault, so every device agrees.
   */
  private activeSwitch(parent: HTMLElement, path: string, name: string) {
    const on = this.plugin.index.isActive(path);
    const sw = parent.createDiv({
      cls: `checkbox-container tc-active-switch${on ? " is-enabled" : ""}`,
      attr: { role: "switch", "aria-checked": String(on), "aria-label": on ? `${name}: studied — tap to leave out` : `${name}: left out of studying — tap to include`, tabindex: "0" },
    });
    sw.createEl("input", { type: "checkbox", attr: { tabindex: "-1" } });
    const flip = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      void this.plugin.studyFolders.toggle(path);
    };
    sw.addEventListener("click", flip);
    sw.addEventListener("keydown", (e) => (e.key === " " || e.key === "Enter") && flip(e));
  }

  /** A sub-deck or note: icon, full name (wraps), counts underneath, study switch, quick-study button. */
  private row(list: HTMLElement, icon: string, path: string, label: string | [string, string], cards: IndexedCards, open: () => void, study: () => void) {
    const name = typeof label === "string" ? label : label[0];
    const c = this.plugin.counts(cards);
    const on = this.plugin.index.isActive(path);
    const row = list.createDiv({ cls: `tc-item${on ? "" : " is-inactive"}` });
    setIcon(row.createSpan({ cls: "tc-item-icon" }), icon);
    const body = row.createDiv({ cls: "tc-item-body" });
    const nameEl = body.createDiv({ cls: "tc-item-name", text: name });
    // Folders inside a one-folder chain: shown quieter, after the deck's own name.
    if (typeof label !== "string") nameEl.createSpan({ cls: "tc-item-inner", text: ` / ${label[1]}` });
    counts(body, c, cards.length, on);
    this.activeSwitch(row, path, name);
    const play = row.createEl("button", { cls: "clickable-icon tc-item-study", attr: { "aria-label": `Study ${name}` } });
    setIcon(play, "play");
    play.disabled = !(c.new + c.due);
    play.onclick = (e) => (e.stopPropagation(), study());
    if (icon === "folder") setIcon(row.createSpan({ cls: "tc-item-chevron" }), "chevron-right");
    row.onclick = open;
  }
}

type IndexedCards = { key: string; blockId: string; deck: string; path: string }[];

/** "12 due · 20 new · 3 learning · 345 cards", leaving out zeros. */
function counts(el: HTMLElement, c: { new: number; learn: number; due: number }, total: number, active = true) {
  const line = el.createDiv({ cls: "tc-item-counts" });
  if (!active) line.createSpan({ cls: "tc-pill tc-off", text: "Not studied" });
  const part = (n: number, text: string, cls: string) => {
    if (!n) return;
    line.createSpan({ cls: `tc-pill ${cls}`, text: `${n} ${text}` });
  };
  part(c.due - c.learn, "due", "tc-count-due");
  part(c.learn, "learning", "tc-count-learn");
  part(c.new, "new", "tc-count-new");
  line.createSpan({ cls: "tc-item-total", text: `${total} card${total === 1 ? "" : "s"}` });
}

function stat(parent: HTMLElement, label: string, value: number, cls = "") {
  const s = parent.createDiv({ cls: "tc-stat" });
  s.createDiv({ cls: `tc-stat-value ${cls}`, text: String(value) });
  s.createDiv({ cls: "tc-stat-label", text: label });
}

