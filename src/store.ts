import { Events, Platform, TFile, normalizePath, type App } from "obsidian";
import { formatLogFile, parseLogFile, logFileName, isLogFileName, deviceOf, dedupeEntries, entrySig } from "./logfile.ts";
import {
  applyEntry, dayKey, groupByKey, makeFsrs, replayKeys, todayCounts,
  type CardState, type DayCounts, type LogEntry, type SchedulerSettings,
} from "./scheduler.ts";
import type { FSRS } from "ts-fsrs";
import { Links } from "./links.ts";

const DEVICE_KEY = "talking-cards-device";
/** Cards replayed between pauses during a full replay, so a big history never freezes the UI. */
const REPLAY_CHUNK = 400;

const yieldToUi = () => new Promise<void>((r) => window.setTimeout(r, 0));

/**
 * All review history. Reads every device's log, writes only this device's.
 * Emits "changed" when card state changes (own reviews or another device's synced log).
 * A card's state depends only on its own entries, so changes replay just the cards they touch.
 */
export class ReviewStore extends Events {
  /** Every entry from every device. */
  entries: LogEntry[] = [];
  states = new Map<string, CardState>();
  deviceId: string;
  /** False until the first full replay finishes. */
  ready = false;
  /** Card IDs joined by edit tracking; history is grouped under each group's root ID. */
  links = new Links();
  private groups = new Map<string, LogEntry[]>();
  /** Root block IDs with any history. */
  private historyBlocks = new Set<string>();
  private own = new Map<string, LogEntry[]>(); // this device: file path → entries
  private others = new Map<string, LogEntry[]>(); // other devices: file path → entries
  private f: FSRS;
  private saveTimer: number | null = null;
  private dirty = new Set<string>();
  private version = 0;
  private todayCache: { version: number; day: string; counts: DayCounts } | null = null;

  constructor(private app: App, private folder: () => string, private sched: () => SchedulerSettings) {
    super();
    this.f = makeFsrs(sched());
    this.deviceId = this.loadDeviceId();
  }

  private loadDeviceId(): string {
    const saved: unknown = this.app.loadLocalStorage(DEVICE_KEY);
    if (typeof saved === "string" && saved) return saved;
    const kind = Platform.isAndroidApp ? "android" : Platform.isIosApp ? "ios" : Platform.isMacOS ? "mac" : Platform.isWin ? "windows" : "linux";
    const id = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
    this.app.saveLocalStorage(DEVICE_KEY, id);
    return id;
  }

  get fsrs(): FSRS {
    return this.f;
  }

  /**
   * Any review log, wherever it is. The data folder is a per-device setting, and Sync may not carry
   * settings, so devices can disagree on it; reading logs from anywhere means none are missed.
   */
  isLogFile(path: string): boolean {
    if (path.startsWith(this.app.vault.configDir + "/") || path.startsWith(".trash/")) return false;
    return isLogFileName(path.split("/").pop()!);
  }

  /** Folders that hold review logs, most logs first. For a fresh install joining an existing vault. */
  logFolders(): string[] {
    const n = new Map<string, number>();
    for (const f of this.app.vault.getFiles()) {
      if (!this.isLogFile(f.path)) continue;
      const dir = f.parent?.path ?? "";
      n.set(dir === "/" ? "" : dir, (n.get(dir) ?? 0) + 1);
    }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  }

  /** Reads every log file and replays it all. At startup and after data-folder or scheduler changes. */
  async load() {
    await this.save();
    this.f = makeFsrs(this.sched());
    this.own.clear();
    this.others.clear();
    // This device's logs found outside the data folder (the folder setting changed, or a copy
    // in two folders): merged into the data folder, the stray files moved to the trash after.
    const stray: TFile[] = [];
    const ownByName = new Map<string, LogEntry[]>();
    for (const file of this.app.vault.getFiles()) {
      if (!this.isLogFile(file.path)) continue;
      const list = parseLogFile(await this.app.vault.cachedRead(file));
      if (deviceOf(file.name) !== this.deviceId) {
        this.others.set(file.path, list);
        continue;
      }
      ownByName.set(file.name, [...(ownByName.get(file.name) ?? []), ...list]);
      if (file.path !== this.ownPath(file.name)) stray.push(file);
    }
    for (const [name, list] of ownByName) {
      const target = this.ownPath(name);
      this.own.set(target, dedupeEntries(list).sort((a, b) => a.t - b.t));
    }
    for (const f of stray) this.dirty.add(this.ownPath(f.name));
    this.entries = this.allEntries();
    this.regroup();
    // Full replay in chunks, yielding between them.
    const states = new Map<string, CardState>();
    let n = 0;
    for (const [k, list] of this.groups) {
      for (const e of list) applyEntry(states, e, this.f, this.sched(), k);
      if (++n % REPLAY_CHUNK === 0) await yieldToUi();
    }
    this.states = states;
    this.spread(this.groups.keys());
    this.ready = true;
    if (stray.length) {
      await this.save();
      for (const f of stray) if (f.path !== this.ownPath(f.name)) await this.app.fileManager.trashFile(f);
    }
    this.changed();
  }

  /** Another device's log changed or was deleted (synced in). Our own writes are ignored. */
  async onFileChanged(file: TFile | { path: string; name: string }, deleted = false) {
    if (!this.isLogFile(file.path) || deviceOf(file.name) === this.deviceId) return;
    const before = this.others.get(file.path) ?? [];
    const after = deleted || !(file instanceof TFile) ? [] : parseLogFile(await this.app.vault.read(file));
    if (deleted) this.others.delete(file.path);
    else this.others.set(file.path, after);
    // Only the cards whose entries differ need replaying.
    const sig = entrySig;
    const old = new Set(before.map(sig));
    const now = new Set(after.map(sig));
    const diff = [...after.filter((e) => !old.has(sig(e))), ...before.filter((e) => !now.has(sig(e)))];
    if (!diff.length) return;
    this.entries = this.allEntries();
    if (diff.some((e) => e.a === "link")) this.replayAll();
    else {
      this.regroup();
      this.replay(new Set(diff.map((e) => this.links.canon(e.k))));
    }
    this.changed();
  }

  /** Where this device's log for a given file name belongs: the data folder. */
  private ownPath(name: string): string {
    return normalizePath(`${this.folder()}/${name}`);
  }

  /** Every device's entries; a log present in two folders counts once. */
  private allEntries(): LogEntry[] {
    return dedupeEntries([...this.own.values(), ...this.others.values()].flat());
  }

    state(key: string): CardState | undefined {
    return this.states.get(key);
  }

  /** True if the card (or a card it was edited from) has been reviewed or acted on. */
  hasHistory(blockId: string): boolean {
    return this.historyBlocks.has(this.links.find(blockId));
  }

  /** Records that block `to` is block `from` after an edit. False if they were already one card. */
  link(from: string, to: string, t = Date.now()): boolean {
    if (this.links.find(from) === this.links.find(to)) return false;
    this.add({ t, k: to, a: "link", from });
    return true;
  }

  /** Groups entries by card (edited cards under one key) and notes which cards have history. */
  private regroup() {
    this.links = new Links(this.entries);
    this.groups = groupByKey(this.entries, (k) => this.links.canon(k));
    this.historyBlocks = new Set([...this.groups.keys()].map((k) => k.split("#")[0]));
  }

  private replayAll() {
    this.regroup();
    this.states = new Map();
    this.replay(this.groups.keys());
  }

  private replay(keys: Iterable<string>) {
    const list = [...keys];
    replayKeys(this.states, this.groups, list, this.f, this.sched());
    this.spread(list);
  }

  /** Makes a card's state readable under every ID it has had: `old#r` shows `root#r`. */
  private spread(keys: Iterable<string>) {
    if (!this.links.size) return;
    for (const k of keys) {
      const i = k.indexOf("#");
      const root = i < 0 ? k : k.slice(0, i);
      const suffix = i < 0 ? "" : k.slice(i);
      const st = this.states.get(k);
      for (const m of this.links.group(root)) {
        if (m === root) continue;
        if (st) this.states.set(m + suffix, st);
        else this.states.delete(m + suffix);
      }
    }
  }

  /** Today's new/review counts across all devices; cached until the log changes. */
  today(now = Date.now()): DayCounts {
    const h = this.sched().dayStartHour;
    const day = dayKey(now, h);
    if (this.todayCache?.version !== this.version || this.todayCache.day !== day) {
      this.todayCache = { version: this.version, day, counts: todayCounts(this.entries, now, h, (k) => this.links.canon(k)) };
    }
    return this.todayCache.counts;
  }

  /** Records a review or action, updates state immediately, saves shortly after. */
  add(e: LogEntry) {
    this.addMany([e]);
  }

  /** Several entries at once (bulk actions): one replay per card, one save, one event. */
  addMany(list: LogEntry[]) {
    const touched = new Set<string>();
    let linked = false;
    for (const e of list) {
      if (e.k.startsWith("~")) throw new Error("Card has no ID yet");
      if (e.a === "link") linked = true;
      const path = normalizePath(`${this.folder()}/${logFileName(this.deviceId, new Date(e.t).getFullYear())}`);
      if (!this.own.has(path)) this.own.set(path, []);
      this.own.get(path)!.push(e);
      this.entries.push(e);
      this.dirty.add(path);
      if (e.a === "link") continue;
      const k = this.links.canon(e.k);
      const g = this.groups.get(k);
      if (!g) this.groups.set(k, [e]);
      else {
        g.push(e);
        if (g.length > 1 && g[g.length - 2].t > e.t) g.sort((a, b) => a.t - b.t);
      }
      this.historyBlocks.add(k.split("#")[0]);
      touched.add(k);
    }
    if (linked) this.replayAll();
    else this.replay(touched);
    this.scheduleSave();
    this.changed();
  }

  /** Removes one of this device's entries (undo). */
  undo(entry: LogEntry): boolean {
    for (const [path, list] of this.own) {
      const i = list.lastIndexOf(entry);
      if (i < 0) continue;
      list.splice(i, 1);
      this.entries.splice(this.entries.lastIndexOf(entry), 1);
      if (entry.a === "link") this.replayAll();
      else {
        const k = this.links.canon(entry.k);
        const g = this.groups.get(k) ?? [];
        g.splice(g.lastIndexOf(entry), 1);
        this.replay([k]);
      }
      this.dirty.add(path);
      this.scheduleSave();
      this.changed();
      return true;
    }
    return false;
  }

  private changed() {
    this.version++;
    this.trigger("changed");
  }

  private scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 1500);
  }

  async save() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const paths = [...this.dirty];
    this.dirty.clear();
    for (const path of paths) {
      const text = formatLogFile(this.deviceId, this.own.get(path) ?? []);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.process(existing, () => text);
      } else {
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => {});
        await this.app.vault.create(path, text);
      }
    }
  }
}
