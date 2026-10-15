import { Component, ItemView, MarkdownRenderer, Notice, Scope, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type TalkingCards from "./main.ts";
import type { Card } from "./parser.ts";
import { speechFor } from "./speech-text.ts";
import { allowSleep, keepAwake } from "./wake.ts";
import { attachSwipe, flingTo, type Direction } from "./swipe.ts";
import { tick } from "./haptics.ts";

const AUDIO_MODE_KEY = "talking-cards-audio-mode";
import {
  buildQueue, mixQueue, preview, formatInterval, isLearning, isNew, endOfDay,
  RATING_NAMES, type LogEntry, type Rating,
} from "./scheduler.ts";

export const REVIEW_VIEW = "talking-cards-review";

/** What to study: everything, one deck (folder path), or one note. Cram ignores due dates and doesn't schedule. */
export interface StudyScope {
  kind: "all" | "deck" | "note";
  value: string;
  cram?: boolean;
}

type SessionCard = Card & { path: string; deck: string };

const LEARN_AHEAD_MS = 20 * 60_000;

export class ReviewView extends ItemView {
  scope: Scope;
  private study: StudyScope = { kind: "all", value: "" };
  private main: SessionCard[] = [];
  /** Cards in learning steps, waiting for their due time this session. */
  private pending = new Map<string, { card: SessionCard; due: number }>();
  private current: SessionCard | null = null;
  private currentFromMain = false;
  private revealed = false;
  private shownAt = 0;
  private history: {
    card: SessionCard;
    fromMain: boolean;
    entry: LogEntry | null;
    pendingBefore: Map<string, { card: SessionCard; due: number }>;
  }[] = [];
  private done = 0;
  private cardComponent: Component | null = null;
  private waitTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TalkingCards) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
    const key = (k: string, fn: () => void, mods: ("Mod" | "Shift")[] = []) =>
      this.scope.register(mods, k, (e) => {
        e.preventDefault();
        fn();
        return false;
      });
    const primary = () => (this.revealed ? this.grade(3) : this.reveal());
    key(" ", primary);
    key("Space", primary);
    key("Enter", primary);
    key("a", () => this.setAudioMode(!this.audioMode));
    for (const r of [1, 2, 3, 4] as Rating[]) key(String(r), () => this.revealed && this.grade(r));
    key("u", () => this.undo());
    key("z", () => this.undo(), ["Mod"]);
    key("e", () => void this.edit());
    key("b", () => this.bury());
    key("s", () => this.suspend());
    key("r", () => void this.say(this.revealed ? "back" : "front"));
  }

  getViewType() {
    return REVIEW_VIEW;
  }
  getDisplayText() {
    return this.study.cram ? "Cram" : "Review";
  }
  getIcon() {
    return "layers";
  }

  getState() {
    return { ...this.study };
  }

  async setState(state: StudyScope, result: ViewStateResult) {
    this.study = { kind: state.kind ?? "all", value: state.value ?? "", cram: !!state.cram };
    await super.setState(state, result);
    await this.start();
  }

  async onOpen() {
    this.contentEl.addClass("tc-review");
  }

  async onClose() {
    this.detachSwipe?.();
    this.cancelFlow();
    void allowSleep();
    this.plugin.tts.stop();
    this.clearWait();
    this.cardComponent?.unload();
    await this.plugin.store.save();
  }

  private scopeCards(): SessionCard[] {
    const { kind, value } = this.study;
    return this.plugin.index.allCards().filter((c) =>
      kind === "all" ? true : kind === "note" ? c.path === value : c.deck === value || c.deck.startsWith(value + "/"),
    );
  }

  async start() {
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "tc-muted", text: "Preparing cards…" });
    const index = this.plugin.index;
    // A review tab restored at startup opens before the vault has been scanned.
    if (!index.ready) await new Promise<void>((resolve) => {
      const ref = index.on("changed", () => {
        index.offref(ref);
        resolve();
      });
    });
    const s0 = this.plugin.settings;
    if (s0.autoReadFront || s0.autoReadBack || this.audioMode) this.plugin.tts.warm();
    const paths = [...new Set(this.scopeCards().map((c) => c.path))];
    await this.plugin.ensureIds(paths);
    const cards = this.scopeCards();
    this.pending.clear();
    this.history = [];
    this.done = 0;

    if (this.study.cram) {
      this.main = shuffle(cards);
    } else {
      const now = Date.now();
      const store = this.plugin.store;
      const s = this.plugin.settings;
      const byKey = new Map(cards.map((c) => [c.key, c]));
      const q = buildQueue(cards, store.states, store.today(now), now, s, s.dayStartHour);
      for (const c of q.learning) this.pending.set(c.key, { card: byKey.get(c.key)!, due: +store.state(c.key)!.fsrs.due });
      if (s.newSort === "random") q.new = shuffle(q.new);
      const order = s.newOrder === "first" ? [...q.new, ...q.review] : s.newOrder === "last" ? [...q.review, ...q.new] : mixQueue(q);
      this.main = order.map((c) => byKey.get(c.key)!);
      if (s.sessionLimit > 0) this.main = this.main.slice(0, s.sessionLimit);
    }
    this.next();
  }

  private next() {
    this.clearWait();
    const now = Date.now();
    const learnDue = [...this.pending.values()].sort((a, b) => a.due - b.due);
    let pick: SessionCard | undefined;
    if (learnDue[0] && learnDue[0].due <= now) pick = learnDue[0].card;
    else if (this.main.length) pick = this.main.shift();
    else if (learnDue[0] && learnDue[0].due - now <= LEARN_AHEAD_MS) pick = learnDue[0].card;
    this.currentFromMain = !!pick && !this.pending.has(pick.key);
    if (pick) this.pending.delete(pick.key);
    this.current = pick ?? null;
    this.revealed = false;
    this.shownAt = Date.now();
    this.render();
    this.onShown();
  }

  /** Reads the question (audio mode or auto-read) and gets upcoming cards' audio ready. */
  private onShown() {
    const c = this.current;
    this.cancelFlow();
    if (!c) return this.plugin.tts.stop();
    const s = this.plugin.settings;
    const tts = this.plugin.tts;
    const readFront = this.audioMode || s.autoReadFront;
    const readBack = this.audioMode || s.autoReadBack;
    if (this.audioMode) void this.audioFront();
    else if (readFront) void this.say("front", true);
    else tts.stop();
    if (!tts.hasAnyVoice()) return;
    if (readBack) tts.prefetch(this.speech(c, "back"), tts.prefs.back, this.override(c, "back"));
    for (const n of this.upcoming(2)) {
      if (readFront) tts.prefetch(this.speech(n, "front"), tts.prefs.front, this.override(n, "front"));
      if (readBack) tts.prefetch(this.speech(n, "back"), tts.prefs.back, this.override(n, "back"));
    }
  }

  private upcoming(n: number): SessionCard[] {
    const now = Date.now();
    const learn = [...this.pending.values()].filter((p) => p.due <= now + 60_000).map((p) => p.card);
    return [...learn, ...this.main].slice(0, n);
  }

  private speech(c: SessionCard, side: "front" | "back"): string {
    return speechFor(side === "front" ? c.front : c.back);
  }

  /** Per-note voice override; a reversed card swaps sides. */
  private override(c: SessionCard, side: "front" | "back"): string | undefined {
    const t = this.plugin.index.notes.get(c.path)?.tts;
    const rev = c.key.endsWith("#r");
    return side === "front" ? (rev ? t?.back : t?.front) : rev ? t?.front : t?.back;
  }

  private warnedNoVoice = false;

  /** Speaks one side. Resolves true once it has finished playing, false if it couldn't. */
  private async say(side: "front" | "back", auto = false): Promise<boolean> {
    const c = this.current;
    if (!c) return false;
    const tts = this.plugin.tts;
    if (!auto) tts.unlock();
    if (auto && !tts.hasAnyVoice()) {
      if (!this.warnedNoVoice) new Notice("No voice on this device yet — get one in Talking Cards settings.");
      this.warnedNoVoice = true;
      return false;
    }
    try {
      await tts.speak(this.speech(c, side), tts.prefs[side], this.override(c, side));
      return true;
    } catch (e) {
      new Notice((e as Error).message);
      return false;
    }
  }

  // ---------- audio mode ----------

  private audioMode = this.app.loadLocalStorage(AUDIO_MODE_KEY) === true;
  /** Bumped whenever the automatic flow should stop (a tap, a key, a new card). */
  private flow = 0;
  private flowTimer: number | null = null;
  private countdownEnd = 0;

  private setAudioMode(on: boolean) {
    this.audioMode = on;
    this.app.saveLocalStorage(AUDIO_MODE_KEY, on);
    if (on) {
      this.plugin.tts.unlock();
      if (this.plugin.settings.keepAwake) void keepAwake();
    } else {
      void allowSleep();
    }
    this.cancelFlow();
    this.render();
    if (on && this.current) {
      if (this.revealed) void this.audioBack();
      else void this.audioFront();
    }
  }

  private cancelFlow() {
    this.flow++;
    if (this.flowTimer) window.clearTimeout(this.flowTimer);
    this.flowTimer = null;
    this.countdownEnd = 0;
  }

  private wait(ms: number, token: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.flowTimer) window.clearTimeout(this.flowTimer);
      this.flowTimer = window.setTimeout(() => resolve(token === this.flow), ms);
    });
  }

  /** Question → think time (with countdown) → reveal. */
  private async audioFront() {
    const token = this.flow;
    if (this.plugin.settings.keepAwake) void keepAwake();
    const ok = await this.say("front", true);
    if (token !== this.flow) return;
    if (!ok) return this.setAudioMode(false);
    const think = this.plugin.settings.audioThinkSeconds;
    if (think <= 0) return; // wait for a tap
    this.countdownEnd = Date.now() + think * 1000;
    this.render();
    if (await this.wait(think * 1000, token)) this.reveal();
  }

  /** Answer → optional auto-Good. */
  private async audioBack() {
    const token = this.flow;
    const ok = await this.say("back", true);
    if (token !== this.flow || !ok) return;
    const auto = this.plugin.settings.audioAutoGoodSeconds;
    if (auto <= 0) return;
    this.countdownEnd = Date.now() + auto * 1000;
    this.render();
    if (await this.wait(auto * 1000, token)) this.grade(3);
  }

  private counts() {
    let n = 0, l = this.pending.size, r = 0;
    for (const c of this.main) {
      const st = this.plugin.store.state(c.key);
      if (isNew(st)) n++;
      else if (isLearning(st)) l++;
      else r++;
    }
    return { n, l, r };
  }

  private detachSwipe: (() => void) | null = null;

  private render() {
    const el = this.contentEl;
    const s = this.plugin.settings;
    el.empty();
    this.detachSwipe?.();
    this.detachSwipe = null;
    this.cardComponent?.unload();
    this.cardComponent = this.addChild(new Component());
    el.setCssProps({ "--tc-card-size": `${s.cardTextSize}em` });
    el.toggleClass("tc-align-center", s.cardAlign === "center");
    el.toggleClass("tc-reduce-motion", s.reduceMotion);
    const keys = s.keyHints && window.matchMedia("(pointer: fine)").matches;

    const head = el.createDiv({ cls: "tc-review-head" });
    const back = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Back to dashboard" } });
    setIcon(back, "arrow-left");
    back.onclick = () => this.plugin.openDashboard(this.leaf);
    head.createSpan({ cls: "tc-review-title", text: this.title() });
    const audio = head.createEl("button", {
      cls: `clickable-icon tc-audio-toggle${this.audioMode ? " is-active" : ""}`,
      attr: { "aria-label": this.audioMode ? "Audio mode on (A)" : "Audio mode: read aloud, hands-free (A)" },
    });
    setIcon(audio, "headphones");
    audio.onclick = () => this.setAudioMode(!this.audioMode);
    const reading = s.autoReadFront || s.autoReadBack;
    const speak = head.createEl("button", {
      cls: `clickable-icon tc-read-toggle${reading ? " is-active" : ""}`,
      attr: { "aria-label": reading ? "Reading cards aloud — tap to stop" : "Read cards aloud" },
    });
    setIcon(speak, reading ? "volume-2" : "volume-x");
    speak.onclick = () => this.setReadAloud(!reading);
    el.toggleClass("tc-audio", this.audioMode);
    const { n, l, r } = this.counts();
    const cnt = head.createSpan({ cls: "tc-counts" });
    cnt.createSpan({ cls: "tc-count-new", text: String(n) });
    cnt.createSpan({ cls: "tc-count-learn", text: String(l) });
    cnt.createSpan({ cls: "tc-count-due", text: String(r) });
    if (s.showProgress) {
      const left = n + l + r + (this.current ? 1 : 0);
      const total = this.done + left;
      el.createDiv({ cls: "tc-progress" }).createDiv({ cls: "tc-progress-fill" }).style.width = `${total ? (this.done / total) * 100 : 100}%`;
    }

    const c = this.current;
    if (!c) return this.renderDone(el);

    const glow = el.createDiv({ cls: "tc-swipe-glow" });
    const hint = el.createDiv({ cls: "tc-swipe-hint" });
    const card = el.createDiv({ cls: "tc-card" });
    if (s.showContext && c.context.length) card.createDiv({ cls: "tc-context", text: c.context.join(" › ") });
    const cloze = c.kind === "cloze";
    const answerOnly = this.revealed && !cloze && !s.keepQuestion;
    const rendering: Promise<void>[] = [];
    if (!answerOnly) {
      const front = this.side(card, "tc-front", this.revealed && cloze ? "back" : "front");
      rendering.push(MarkdownRenderer.render(this.app, cloze && this.revealed ? c.back : c.front, front, c.path, this.cardComponent));
    }
    if (this.revealed && !cloze) {
      if (!answerOnly) card.createEl("hr", { cls: "tc-divider" });
      const backEl = this.side(card, "tc-back", "back");
      rendering.push(MarkdownRenderer.render(this.app, c.back, backEl, c.path, this.cardComponent));
    }
    void Promise.all(rendering).then(() => window.requestAnimationFrame(() => fitText(el, card, s.cardTextSize)));

    if (this.countdownEnd > Date.now()) {
      const cd = el.createDiv({ cls: "tc-countdown" });
      const fill = cd.createDiv({ cls: "tc-countdown-fill" });
      fill.style.animationDuration = `${this.countdownEnd - Date.now()}ms`;
    }

    const gradeable = this.revealed;
    const swipeOn = s.swipe && gradeable;
    card.toggleClass("tc-swipeable", swipeOn);
    const tapReveals = !this.revealed && (s.tapToReveal || this.audioMode);
    card.toggleClass("tc-tappable", tapReveals);
    this.detachSwipe = attachSwipe(card, {
      enabled: () => s.swipe && this.revealed,
      threshold: () => s.swipeThreshold,
      // A long card needs vertical scrolling; then only sideways swipes grade.
      horizontalOnly: () => card.scrollHeight > card.clientHeight + 4,
      onTap: () => {
        if (!this.revealed && (s.tapToReveal || this.audioMode)) this.reveal();
      },
      onDrag: (d) => this.dragFeedback(card, glow, hint, d),
      onThrow: (dir) => this.throwCard(card, glow, hint, dir),
    });

    const bar = el.createDiv({ cls: "tc-answer-bar" });
    if (!this.revealed) {
      const btn = bar.createEl("button", { cls: "mod-cta tc-show", text: this.audioMode ? "Reveal" : "Show answer" });
      if (keys) btn.createSpan({ cls: "tc-kbd", text: "Space" });
      btn.onclick = () => this.reveal();
    } else if (this.study.cram) {
      const btn = bar.createEl("button", { cls: "mod-cta tc-show", text: "Next" });
      if (keys) btn.createSpan({ cls: "tc-kbd", text: "Space" });
      btn.onclick = () => this.grade(3);
    } else {
      const now = Date.now();
      const p = preview(this.plugin.store.state(c.key), now, this.plugin.store.fsrs);
      const ratings: Rating[] = s.gradeButtons === 2 ? [1, 3] : [1, 2, 3, 4];
      bar.toggleClass("tc-two", ratings.length === 2);
      for (const rating of ratings) {
        const b = bar.createEl("button", { cls: `tc-grade tc-grade-${rating}` });
        if (s.showIntervals) b.createSpan({ cls: "tc-grade-ivl", text: formatInterval(p[rating] - now) });
        b.createSpan({ cls: "tc-grade-name", text: RATING_NAMES[rating - 1] });
        if (keys) b.createSpan({ cls: "tc-kbd", text: String(rating) });
        b.onclick = () => this.grade(rating);
      }
    }

    if (s.showToolbar) {
      const tools = el.createDiv({ cls: "tc-tools" });
      tool(tools, "undo-2", "Undo (U)", () => this.undo(), !this.history.length);
      tool(tools, "pencil", "Edit in note (E)", () => void this.edit());
      if (!this.study.cram) {
        tool(tools, "clock", "Bury until tomorrow (B)", () => this.bury());
        tool(tools, "pause", "Suspend (S)", () => this.suspend());
      }
    }
  }

  // ---------- swipe ----------

  private swipeGrade(dir: Direction): Rating | 0 {
    const s = this.plugin.settings;
    const g = { up: s.swipeUp, right: s.swipeRight, down: s.swipeDown, left: s.swipeLeft }[dir];
    // Cram has no grades: any assigned direction means "next".
    return g && this.study.cram ? 3 : g;
  }

  private wasArmed = false;

  private dragFeedback(card: HTMLElement, glow: HTMLElement, hint: HTMLElement, d: { dir: Direction | null; t: number; armed: boolean; dx: number; dy: number }) {
    const s = this.plugin.settings;
    const rating = d.dir ? this.swipeGrade(d.dir) : 0;
    if (!d.dir || !rating) {
      card.setCssStyles({ transition: s.reduceMotion ? "" : "transform 180ms ease-out, opacity 180ms linear", transform: "", opacity: "" });
      glow.setCssStyles({ opacity: "0" });
      hint.setCssStyles({ opacity: "0" });
      this.wasArmed = false;
      return;
    }
    card.setCssStyles({ transition: "none" });
    if (!s.reduceMotion) {
      // The card recedes as it goes, so the grade label stays readable over it.
      card.setCssStyles({ opacity: String(1 - d.t * 0.55), transform: `translate(${d.dx}px, ${d.dy}px) rotate(${(d.dx / 18).toFixed(2)}deg)` });
    }
    glow.dataset.grade = String(rating);
    glow.setCssStyles({ opacity: String(0.1 + d.t * 0.22) });
    hint.dataset.grade = String(rating);
    hint.setText(this.study.cram ? "Next" : RATING_NAMES[rating - 1]);
    hint.setCssStyles({ opacity: String(Math.min(1, d.t * 1.3)) });
    hint.toggleClass("is-armed", d.armed);
    if (d.armed && !this.wasArmed && s.haptics) tick();
    this.wasArmed = d.armed;
  }

  /** Fling the card off, then grade — slightly before the animation ends so fast runs never wait. */
  private throwCard(card: HTMLElement, glow: HTMLElement, hint: HTMLElement, dir: Direction) {
    const rating = this.swipeGrade(dir);
    const c = this.current;
    if (!rating || !c) return this.dragFeedback(card, glow, hint, { dir: null, t: 0, armed: false, dx: 0, dy: 0 });
    this.wasArmed = false;
    if (this.plugin.settings.reduceMotion) return this.grade(rating);
    const to = flingTo(dir, window.innerWidth, window.innerHeight);
    card.setCssStyles({ transition: "transform 300ms cubic-bezier(0.32,0,0.67,0), opacity 300ms linear", transform: `translate(${to.x}px, ${to.y}px) rotate(${to.rot}deg)`, opacity: "0" });
    glow.setCssStyles({ opacity: "0.34" });
    hint.setCssStyles({ opacity: "0" });
    window.setTimeout(() => {
      if (this.current === c && this.revealed) this.grade(rating);
    }, 190);
  }

  /** A card side with its 🔊 button; returns the element to render Markdown into. */
  private side(parent: HTMLElement, cls: string, speak: "front" | "back"): HTMLElement {
    const wrap = parent.createDiv({ cls: `tc-side-wrap ${cls}` });
    const body = wrap.createDiv({ cls: "tc-side markdown-rendered" });
    if (this.plugin.settings.showSpeakers) {
      const btn = wrap.createEl("button", { cls: "clickable-icon tc-say", attr: { "aria-label": "Read aloud (R)" } });
      setIcon(btn, "volume-2");
      btn.onclick = () => this.say(speak);
    }
    return body;
  }

  private renderDone(el: HTMLElement) {
    void allowSleep();
    const box = el.createDiv({ cls: "tc-done" });
    const soonest = Math.min(...[...this.pending.values()].map((p) => p.due));
    if (Number.isFinite(soonest)) {
      const wait = soonest - Date.now();
      box.createEl("h3", { text: "Waiting on learning cards" });
      box.createEl("p", { cls: "tc-muted", text: `Next one is due in ${formatInterval(wait)}. Keep this open or come back later.` });
      this.waitTimer = window.setTimeout(() => this.next(), Math.max(1000, wait - LEARN_AHEAD_MS));
    } else {
      box.createEl("h3", { text: this.done ? "Done for now 🎉" : "Nothing to study" });
      box.createEl("p", { cls: "tc-muted", text: this.done ? `${this.done} card${this.done === 1 ? "" : "s"} this session.` : "No cards are due here." });
      if (this.history.length) tool(box, "undo-2", "Undo last", () => this.undo());
    }
    const btn = box.createEl("button", { text: "Back to dashboard" });
    btn.onclick = () => this.plugin.openDashboard(this.leaf);
  }

  private title(): string {
    const { kind, value, cram } = this.study;
    const name = kind === "all" ? "All cards" : kind === "note" ? value.split("/").pop()!.replace(/\.md$/, "") : value.split("/").pop() || "Vault root";
    return cram ? `Cram: ${name}` : name;
  }

  /** The speaker button: read both sides as they appear (sets the two auto-read settings). */
  private setReadAloud(on: boolean) {
    const s = this.plugin.settings;
    s.autoReadFront = on;
    s.autoReadBack = on;
    void this.plugin.saveSettings("none");
    this.render();
    if (!on) return this.plugin.tts.stop();
    this.plugin.tts.unlock(); // this tap is the gesture mobile needs before audio can play
    this.plugin.tts.warm();
    void this.say(this.revealed ? "back" : "front", true);
  }

  /** Also takes over from audio mode's timer when the user taps first. */
  private reveal() {
    if (!this.current || this.revealed) return;
    this.cancelFlow();
    this.revealed = true;
    this.render();
    if (this.audioMode) void this.audioBack();
    else if (this.plugin.settings.autoReadBack) void this.say("back", true);
  }

  private grade(rating: Rating) {
    const c = this.current;
    if (!c || !this.revealed) return;
    this.cancelFlow();
    const pendingBefore = new Map(this.pending);
    let entry: LogEntry | null = null;
    if (!this.study.cram) {
      const now = Date.now();
      entry = { t: now, k: c.key, r: rating, ms: Math.min(now - this.shownAt, 300_000) };
      this.plugin.store.add(entry);
      const st = this.plugin.store.state(c.key)!;
      const s = this.plugin.settings;
      if (rating === 1 && s.leechThreshold > 0 && st.fsrs.lapses === s.leechThreshold) {
        if (s.leechSuspend) {
          this.plugin.store.add({ t: now + 1, k: c.key, a: "suspend" });
          new Notice("Leech: you've forgotten this card " + st.fsrs.lapses + " times, so it's suspended. Rewrite it, then unsuspend it in Browse.", 8000);
        } else {
          new Notice("Leech: you've forgotten this card " + st.fsrs.lapses + " times. Consider rewriting it (E to edit).", 8000);
        }
      }
      if (isLearning(st) && +st.fsrs.due <= endOfDay(now, s.dayStartHour)) this.pending.set(c.key, { card: c, due: +st.fsrs.due });
    }
    this.history.push({ card: c, fromMain: this.currentFromMain, entry, pendingBefore });
    this.done++;
    this.next();
  }

  private undo() {
    const last = this.history.pop();
    if (!last) return;
    if (last.entry) this.plugin.store.undo(last.entry);
    if (this.current && this.currentFromMain) this.main.unshift(this.current);
    this.pending = last.pendingBefore;
    this.currentFromMain = last.fromMain;
    this.done--;
    this.current = last.card;
    this.revealed = false;
    this.shownAt = Date.now();
    this.render();
    this.onShown();
  }

  private action(a: "bury" | "suspend", msg: string) {
    const c = this.current;
    if (!c || this.study.cram) return;
    this.plugin.store.add({ t: Date.now(), k: c.key, a });
    new Notice(msg);
    this.next();
  }

  private bury() {
    this.action("bury", "Buried until tomorrow");
  }

  private suspend() {
    this.action("suspend", "Suspended — unsuspend it from the card browser");
  }

  private async edit() {
    const c = this.current;
    if (!c) return;
    const file = this.app.vault.getAbstractFileByPath(c.path);
    if (!(file instanceof TFile)) return;
    const block = this.plugin.index.notes.get(c.path)?.blocks.find((b) => b.id === c.blockId);
    await this.app.workspace.getLeaf("split").openFile(file, { eState: { line: block?.firstLine ?? 0 } });
  }

  private clearWait() {
    if (this.waitTimer) window.clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }
}

function tool(parent: HTMLElement, icon: string, label: string, fn: () => void, disabled = false) {
  const b = parent.createEl("button", { cls: "clickable-icon tc-tool", attr: { "aria-label": label } });
  setIcon(b, icon);
  b.disabled = disabled;
  b.onclick = fn;
}

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Shrinks a long card's text until it fits (to two-thirds of the chosen size), so cards rarely
 * scroll: a scrolling card can only be swiped sideways, since up/down drags scroll it.
 */
function fitText(view: HTMLElement, card: HTMLElement, base: number) {
  const overflows = () => card.scrollHeight > card.clientHeight + 4;
  let size = base;
  view.setCssProps({ "--tc-card-size": `${size}em` });
  while (overflows() && size > base * 0.66) {
    size = Math.round((size - 0.05) * 100) / 100;
    view.setCssProps({ "--tc-card-size": `${size}em` });
  }
  card.toggleClass("tc-scrolls", overflows());
}
