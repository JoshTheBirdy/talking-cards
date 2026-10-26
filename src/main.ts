import { Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { CardIndex, type IndexSettings } from "./index.ts";
import { DashboardView, DASHBOARD_VIEW } from "./dashboard.ts";
import { ReviewView, REVIEW_VIEW, type StudyScope } from "./review.ts";
import { ReviewStore } from "./store.ts";
import { EditTracker } from "./edit-tracker.ts";
import { registerOcclusion } from "./occlusion-view.ts";
import { parseNote, addMissingIds, type CardBlock } from "./parser.ts";
import { DEFAULT_SCHEDULER, buildQueue, type QueueLimits, type SchedulerSettings } from "./scheduler.ts";
import { Tts } from "./tts/tts.ts";
import { VoiceStoreModal, speedLabel, voiceName } from "./tts/voice-store.ts";
import { formatBytes } from "./tts/piper-engine.ts";

interface SpeechSettings {
  autoReadFront: boolean;
  autoReadBack: boolean;
  /** Audio cache limit, MB. */
  audioCacheMb: number;
  /** Audio mode: seconds between question and answer; 0 = wait for a tap. */
  audioThinkSeconds: number;
  /** Audio mode: grade Good automatically this long after the answer; 0 = off. */
  audioAutoGoodSeconds: number;
  keepAwake: boolean;
}

export type GradeOrNone = 0 | 1 | 2 | 3 | 4;

/** How the review screen looks and behaves. All synced (data.json). */
export interface ReviewSettings {
  swipe: boolean;
  swipeUp: GradeOrNone;
  swipeRight: GradeOrNone;
  swipeDown: GradeOrNone;
  swipeLeft: GradeOrNone;
  /** Pixels a drag must travel to count. */
  swipeThreshold: number;
  haptics: boolean;
  /** em */
  cardTextSize: number;
  cardAlign: "left" | "center";
  tapToReveal: boolean;
  keepQuestion: boolean;
  showContext: boolean;
  showProgress: boolean;
  showIntervals: boolean;
  gradeButtons: 2 | 4;
  showToolbar: boolean;
  showSpeakers: boolean;
  keyHints: boolean;
  reduceMotion: boolean;
  /** Max cards per session (0 = no limit). */
  sessionLimit: number;
  newOrder: "mix" | "first" | "last";
  newSort: "note" | "random";
}

interface LeechSettings {
  /** Lapses that make a card a leech; 0 = off. */
  leechThreshold: number;
  leechSuspend: boolean;
}

interface Settings extends IndexSettings, SchedulerSettings, QueueLimits, SpeechSettings, LeechSettings, ReviewSettings {}

const DEFAULTS: Settings = {
  braceCloze: true,
  highlightCloze: false,
  codeBlockCards: true,
  ignore: ["Templates", "Template"],
  dataFolder: "Talking Cards",
  writeIds: false,
  dedupe: true,
  dedupePrefer: "flashcard",
  trackEdits: true,
  ...DEFAULT_SCHEDULER,
  newPerDay: 20,
  reviewsPerDay: 200,
  burySiblings: true,
  autoReadFront: false,
  autoReadBack: false,
  audioCacheMb: 200,
  audioThinkSeconds: 5,
  audioAutoGoodSeconds: 0,
  keepAwake: true,
  leechThreshold: 8,
  leechSuspend: false,
  // The two most-used grades on the axis a thumb finds without aiming.
  swipe: true,
  swipeUp: 3,
  swipeRight: 4,
  swipeDown: 1,
  swipeLeft: 2,
  swipeThreshold: 72,
  haptics: true,
  cardTextSize: 1.1,
  cardAlign: "center",
  tapToReveal: true,
  keepQuestion: true,
  showContext: true,
  showProgress: true,
  showIntervals: true,
  gradeButtons: 4,
  showToolbar: true,
  showSpeakers: true,
  keyHints: true,
  reduceMotion: false,
  sessionLimit: 0,
  newOrder: "mix",
  newSort: "random",
};

export default class TalkingCards extends Plugin {
  settings: Settings = DEFAULTS;
  index!: CardIndex;
  store!: ReviewStore;
  edits!: EditTracker;
  tts!: Tts;
  private statusEl!: HTMLElement;

  async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    this.index = new CardIndex(this.app, () => this.settings);
    this.store = new ReviewStore(this.app, () => this.settings.dataFolder, () => this.settings);
    this.edits = new EditTracker(this);
    this.tts = new Tts(this.app);
    this.tts.piper.cacheLimit = this.settings.audioCacheMb * 1024 * 1024;
    void this.tts.init();

    this.registerView(DASHBOARD_VIEW, (leaf) => new DashboardView(leaf, this));
    this.registerView(REVIEW_VIEW, (leaf) => new ReviewView(leaf, this));
    this.addRibbonIcon("layers", "Talking Cards", () => this.openDashboard());
    this.addSettingTab(new SettingsTab(this.app, this));

    this.addCommand({ id: "open-dashboard", name: "Open dashboard", callback: () => this.openDashboard() });
    this.addCommand({ id: "browse-cards", name: "Browse cards", callback: () => this.openDashboard(undefined, "browse") });
    this.addCommand({ id: "open-stats", name: "Show stats", callback: () => this.openDashboard(undefined, "stats") });
    this.addCommand({
      id: "browse-note",
      name: "Browse cards in this note",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !this.index.notes.has(f.path)) return false;
        if (!checking) void this.openDashboard(undefined, "browse", { query: f.path });
        return true;
      },
    });
    this.addCommand({ id: "study-all", name: "Study all due cards", callback: () => this.study({ kind: "all", value: "" }) });
    this.addCommand({
      id: "study-note",
      name: "Study cards in this note",
      checkCallback: (checking) => this.noteCommand(checking, false),
    });
    this.addCommand({
      id: "cram-note",
      name: "Cram this note (ignores schedule)",
      checkCallback: (checking) => this.noteCommand(checking, true),
    });
    this.addCommand({
      id: "study-deck",
      name: "Study this note's deck",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const deck = f && this.index.notes.get(f.path)?.deck;
        if (deck === undefined || deck === null) return false;
        if (!checking) void this.study({ kind: deck ? "deck" : "all", value: deck });
        return true;
      },
    });

    registerOcclusion(this);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.onclick = () => this.openDashboard();
    this.registerEvent(this.index.on("changed", () => this.updateStatus()));
    this.registerEvent(this.store.on("changed", () => this.updateStatus()));
    this.registerInterval(window.setInterval(() => this.updateStatus(), 60_000));

    this.app.workspace.onLayoutReady(async () => {
      await this.store.load();
      await this.index.build();
      await this.edits.checkSnapshot();
      this.registerEvent(this.index.on("edited", (...a: unknown[]) => this.edits.onEdited(...(a as [string, CardBlock[], CardBlock[]]))));
      this.registerEvent(this.store.on("changed", () => this.edits.scheduleSave()));
      this.registerEvent(this.app.metadataCache.on("changed", (f) => this.index.update(f)));
      this.registerEvent(this.app.vault.on("modify", (f) => f instanceof TFile && this.store.onFileChanged(f)));
      this.registerEvent(this.app.vault.on("create", (f) => f instanceof TFile && this.store.onFileChanged(f)));
      this.registerEvent(
        this.app.vault.on("delete", (f) => {
          this.index.remove(f.path);
          if (f instanceof TFile) void this.store.onFileChanged(f, true);
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (f, old) => {
          this.index.remove(old);
          if (f instanceof TFile) void this.index.update(f);
        }),
      );
    });
  }

  onunload() {
    this.tts.unload();
    void this.store.save().then(() => this.edits.save());
  }

  private noteCommand(checking: boolean, cram: boolean): boolean {
    const f = this.app.workspace.getActiveFile();
    if (!f || !this.index.notes.has(f.path)) return false;
    if (!checking) void this.study({ kind: "note", value: f.path, cram });
    return true;
  }

  dueCount(): number {
    return this.index.ready ? this.counts(this.index.allCards()).due : 0;
  }

  /** New / learning / due for a set of cards, respecting today's limits. */
  counts(cards: { key: string; blockId: string }[]) {
    const now = Date.now();
    const s = this.settings;
    const q = buildQueue(cards, this.store.states, this.store.today(now), now, s, s.dayStartHour);
    return { new: q.new.length, learn: q.learning.length, due: q.review.length + q.learning.length };
  }

  updateStatus() {
    if (!this.index.ready || !this.store.ready) return;
    const c = this.counts(this.index.allCards());
    const n = c.due + c.new;
    this.statusEl.setText(n ? `🗂 ${n} to study` : "🗂 all done");
  }

  async openDashboard(leaf?: WorkspaceLeaf, tab?: "overview" | "browse" | "stats", browse?: { deck?: string; query?: string }) {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW)[0];
    const target = leaf ?? existing ?? this.app.workspace.getLeaf("tab");
    if (target.view.getViewType() !== DASHBOARD_VIEW) await target.setViewState({ type: DASHBOARD_VIEW, active: true });
    if (tab && target.view instanceof DashboardView) target.view.show(tab, browse);
    void this.app.workspace.revealLeaf(target);
  }

  async study(scope: StudyScope, leaf?: WorkspaceLeaf) {
    // Called from a tap: let audio start now, so the first card can be read aloud straight away.
    if (this.settings.autoReadFront || this.settings.autoReadBack) this.tts.unlock();
    const target = leaf ?? this.app.workspace.getLeavesOfType(REVIEW_VIEW)[0] ?? this.app.workspace.getLeaf("tab");
    await target.setViewState({ type: REVIEW_VIEW, active: true, state: { ...scope } });
    void this.app.workspace.revealLeaf(target);
  }

  /** Gives every card in these notes a `^tc-` ID, and re-IDs pasted duplicates. */
  async ensureIds(paths: string[]) {
    if (!this.settings.writeIds) return; // cards are identified by their text; notes stay untouched
    const owner = new Map<string, string>(); // id → first path that has it
    for (const n of this.index.notes.values()) for (const b of n.blocks) if (b.id && !owner.has(b.id)) owner.set(b.id, n.path);
    const taken = new Set(owner.keys());
    let changed = 0;
    for (const path of paths) {
      const note = this.index.notes.get(path);
      if (!note) continue;
      const dups = new Set(note.blocks.filter((b) => b.id && owner.get(b.id) !== path).map((b) => b.id!));
      if (note.blocks.every((b) => b.id) && !dups.size && new Set(note.blocks.map((b) => b.id)).size === note.blocks.length) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      await this.app.vault.process(file, (text) => addMissingIds(text, parseNote(text, this.settings), taken, dups) ?? text);
      await this.index.update(file, false);
      changed++;
    }
    if (changed) this.index.trigger("changed");
  }

  async saveSettings(reload: "index" | "store" | "none" = "index") {
    await this.saveData(this.settings);
    if (reload === "index") await this.index.build();
    if (reload === "store") await this.store.load();
    this.updateStatus();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: TalkingCards) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = (reload: "index" | "store" | "none") => this.plugin.saveSettings(reload);
    containerEl.empty();

    this.reviewSection(containerEl);

    new Setting(containerEl).setName("Daily limits").setHeading();
    num(containerEl, "New cards per day", "", s.newPerDay, (v) => ((s.newPerDay = v), save("none")));
    num(containerEl, "Reviews per day", "", s.reviewsPerDay, (v) => ((s.reviewsPerDay = v), save("none")));
    new Setting(containerEl)
      .setName("Bury siblings")
      .setDesc("The other side of a reversed card, and other gaps of the same cloze, wait until tomorrow.")
      .addToggle((t) => t.setValue(s.burySiblings).onChange((v) => ((s.burySiblings = v), save("none"))));

    new Setting(containerEl).setName("Scheduling (FSRS)").setHeading();
    new Setting(containerEl)
      .setName("Desired retention")
      .setDesc("Chance you remember a card when it comes due. Higher = more reviews.")
      .addSlider((sl) =>
        sl.setLimits(0.7, 0.97, 0.01).setValue(s.retention).setDynamicTooltip().onChange((v) => ((s.retention = v), save("store"))),
      );
    num(containerEl, "Maximum interval (days)", "", s.maxInterval, (v) => ((s.maxInterval = v), save("store")));
    new Setting(containerEl)
      .setName("Learning steps")
      .setDesc("For new cards, e.g. 1m 10m. Units: m, h, d.")
      .addText((t) =>
        t.setValue(s.learningSteps.join(" ")).onChange((v) => ((s.learningSteps = steps(v, ["1m", "10m"])), save("store"))),
      );
    new Setting(containerEl)
      .setName("Relearning steps")
      .setDesc("For cards you forgot, e.g. 10m.")
      .addText((t) =>
        t.setValue(s.relearningSteps.join(" ")).onChange((v) => ((s.relearningSteps = steps(v, ["10m"])), save("store"))),
      );
    num(containerEl, "Leech after (lapses)", "A card you've forgotten this many times is flagged as a leech. 0 = off.", s.leechThreshold, (v) => ((s.leechThreshold = v), save("none")));
    new Setting(containerEl)
      .setName("Suspend leeches")
      .setDesc("Take leeches out of review until you rewrite them. Off: they're only flagged.")
      .addToggle((t) => t.setValue(s.leechSuspend).onChange((v) => ((s.leechSuspend = v), save("none"))));
    num(containerEl, "Next day starts at (hour)", "Reviews after midnight count toward the previous day until this hour.", s.dayStartHour, (v) => ((s.dayStartHour = Math.min(23, v)), save("store")));

    this.voiceSection(containerEl);

    new Setting(containerEl).setName("Cards").setHeading();
    new Setting(containerEl)
      .setName("Brace clozes")
      .setDesc("{{answer}} and {{c1::answer::hint}} become cloze cards.")
      .addToggle((t) => t.setValue(s.braceCloze).onChange((v) => ((s.braceCloze = v), save("index"))));
    new Setting(containerEl)
      .setName("Highlight clozes")
      .setDesc("==answer== becomes a cloze card. Off by default: every highlight in the vault would become a card.")
      .addToggle((t) => t.setValue(s.highlightCloze).onChange((v) => ((s.highlightCloze = v), save("index"))));
    new Setting(containerEl)
      .setName("Cards in code blocks")
      .setDesc("Read `Question ;; Answer` cards inside plain ``` blocks (decks kept there for copying). Code blocks with a language are never read.")
      .addToggle((t) => t.setValue(!!s.codeBlockCards).onChange((v) => ((s.codeBlockCards = v), save("index"))));
    new Setting(containerEl)
      .setName("Merge duplicate cards")
      .setDesc("On: the same question and answer in several notes is one card with one history. Every folder and note it's written in still shows it, and a review shows it once. Off: every copy is shown, so a review can show the same card twice.")
      .addToggle((t) =>
        t.setValue(s.dedupe).onChange(async (v) => {
          s.dedupe = v;
          await save("none");
          this.plugin.index.refresh();
        }),
      );
    new Setting(containerEl)
      .setName("Show context from")
      .setDesc("When a review has the same card in several notes, show the title and headings of the note whose name contains this (empty: the first found). It never hides a card.")
      .addText((t) =>
        t.setValue(s.dedupePrefer).onChange(async (v) => {
          s.dedupePrefer = v;
          await save("none");
          this.plugin.index.refresh();
        }),
      );
    new Setting(containerEl)
      .setName("Write card IDs into notes")
      .setDesc("Off (default): notes are never changed; a card is recognised by its text, and edits are followed by matching (below). On: adds ^tc-… to each card line the first time you study it, so a card keeps its history through any edit or move.")
      .addToggle((t) => t.setValue(s.writeIds).onChange((v) => ((s.writeIds = v), save("index"))));
    new Setting(containerEl)
      .setName("When a card's text changes")
      .setDesc("Keep progress: an edited card (typo fixed, answer reworded) keeps its history; a rewritten one starts over. Removing ;; or :: removes the card. A card can also take progress from a removed one by hand: Browse → select it → Take progress from.")
      .addDropdown((d) =>
        d
          .addOptions({ keep: "Keep progress", reset: "Start over" })
          .setValue(s.trackEdits ? "keep" : "reset")
          .onChange(async (v) => {
            s.trackEdits = v === "keep";
            await save("none");
          }),
      );
    new Setting(containerEl)
      .setName("Ignore")
      .setDesc("Folders or path fragments to skip, one per line. Anything containing “Template” is skipped by default.")
      .addTextArea((t) =>
        t.setValue(s.ignore.join("\n")).onChange((v) => {
          s.ignore = v.split("\n").map((x) => x.trim()).filter(Boolean);
          return save("index");
        }),
      );
    new Setting(containerEl)
      .setName("Data folder")
      .setDesc("Review history: one .md file per device per year. Add it to Settings → Files and links → Excluded files to keep it out of search.")
      .addText((t) =>
        t.setValue(s.dataFolder).onChange((v) => ((s.dataFolder = v.trim() || DEFAULTS.dataFolder), save("store"))),
      );
    new Setting(containerEl).setName("This device").setDesc(this.plugin.store.deviceId);
  }

  private reviewSection(el: HTMLElement) {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings("none");
    const toggle = (name: string, desc: string, key: keyof ReviewSettings) =>
      new Setting(el).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key] as boolean).onChange((v) => {
          (s as unknown as Record<string, unknown>)[key] = v;
          void save();
        }),
      );
    const choose = <K extends keyof ReviewSettings>(name: string, desc: string, key: K, opts: [string, string][], parse: (v: string) => ReviewSettings[K]) =>
      new Setting(el).setName(name).setDesc(desc).addDropdown((d) => {
        for (const [v, label] of opts) d.addOption(v, label);
        d.setValue(String(s[key]));
        d.onChange((v) => {
          s[key] = parse(v) as Settings[K];
          void save();
        });
      });

    new Setting(el).setName("Swipe to grade").setHeading().setDesc("Once the answer shows, throw the card. The screen takes the colour of the grade you're heading for.");
    toggle("Swipe to grade", "Works with a finger or a mouse drag.", "swipe");
    const grades: [string, string][] = [["0", "Nothing"], ["1", "Again"], ["2", "Hard"], ["3", "Good"], ["4", "Easy"]];
    const g = (v: string) => Number(v) as GradeOrNone;
    choose("Swipe up", "", "swipeUp", grades, g);
    choose("Swipe right", "", "swipeRight", grades, g);
    choose("Swipe down", "", "swipeDown", grades, g);
    choose("Swipe left", "", "swipeLeft", grades, g);
    new Setting(el)
      .setName("Swipe distance")
      .setDesc("How far to drag before letting go grades. Shorter = more sensitive.")
      .addSlider((sl) => sl.setLimits(40, 200, 4).setValue(s.swipeThreshold).setDynamicTooltip().onChange((v) => ((s.swipeThreshold = v), void save())));
    toggle("Haptic tick", "A short vibration when a swipe is far enough to count (phone).", "haptics");

    new Setting(el).setName("Review screen").setHeading().setDesc("The preview shows the settings below as you change them.");
    const preview = cardPreview(el);
    const update = () => preview(s);
    update();
    const live = <K extends keyof ReviewSettings>(name: string, desc: string, key: K) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(s[key] as boolean).onChange((v) => {
            (s[key] as boolean) = v;
            update();
            void save();
          }),
        );
    new Setting(el)
      .setName("Card text size")
      .setDesc("Long cards shrink to fit the screen, down to about two-thirds of this.")
      .addSlider((sl) =>
        sl.setLimits(0.8, 2.4, 0.05).setValue(s.cardTextSize).setDynamicTooltip().onChange((v) => {
          s.cardTextSize = v;
          update();
          void save();
        }),
      );
    new Setting(el).setName("Card text alignment").addDropdown((d) =>
      d
        .addOptions({ center: "Centred", left: "Left" })
        .setValue(s.cardAlign)
        .onChange((v) => {
          s.cardAlign = v as "left" | "center";
          update();
          void save();
        }),
    );
    toggle("Tap the card to reveal", "Tap anywhere on the card instead of the Show answer button.", "tapToReveal");
    live("Keep the question visible", "Off: the answer replaces the question when revealed.", "keepQuestion");
    live("Show where the card is from", "Note › heading › parent bullet, above the question.", "showContext");
    toggle("Progress bar", "", "showProgress");
    choose("Grade buttons", "Two buttons is simpler; FSRS works fine with Again/Good only.", "gradeButtons", [["4", "Again · Hard · Good · Easy"], ["2", "Again · Good"]], (v) => Number(v) as 2 | 4);
    toggle("Show next interval on buttons", "", "showIntervals");
    toggle("Tool row", "Undo, edit, bury, suspend under the buttons.", "showToolbar");
    toggle("Read-aloud buttons", "The 🔊 next to each side.", "showSpeakers");
    toggle("Keyboard hints", "Show Space / 1–4 on buttons when there's a keyboard.", "keyHints");
    toggle("Reduce motion", "No card animations.", "reduceMotion");

    new Setting(el).setName("Study session").setHeading();
    num(el, "Cards per session", "Stop after this many (learning steps still finish). 0 = no limit.", s.sessionLimit, (v) => ((s.sessionLimit = v), save()));
    choose("New cards", "Where new cards go among your reviews.", "newOrder", [["mix", "Mixed in"], ["first", "Before reviews"], ["last", "After reviews"]], (v) => v as "mix" | "first" | "last");
    choose("Card order", "Shuffled picks new cards from anywhere in the deck or note you study (the same picks all day) and mixes up reviews. As written: top to bottom.", "newSort", [["random", "Shuffled"], ["note", "As written in notes"]], (v) => v as "note" | "random");
  }

  /**
   * The phone's own voices (Google, Samsung…) through a companion app's voice server.
   * Obsidian on Android has no speech engine a plugin can reach, so this is optional: the
   * built-in voices work without it. Protocol: docs/voice-server.md.
   */
  private readerSection(el: HTMLElement) {
    const tts = this.plugin.tts;
    const on = !!tts.prefs.readerOn || !!tts.prefs.readerToken;
    new Setting(el)
      .setName("Use the phone's own voices")
      .setDesc("Optional. Obsidian can't reach Android's voices by itself; a companion app (Reader) can share them. Without it, the downloaded voices above are used.")
      .addToggle((t) =>
        t.setValue(on).onChange((v) => {
          tts.prefs.readerOn = v;
          if (!v) {
            tts.prefs.readerToken = "";
            tts.reader.voices = [];
          }
          tts.savePrefs();
          this.display();
        }),
      );
    if (!on) return;
    const status = new Setting(el)
      .setName("Companion app")
      .setDesc(tts.reader.message || "Checks for the voice server on this phone.")
      .addButton((b) =>
        b.setButtonText("Check").onClick(async () => {
          b.setDisabled(true);
          await tts.reader.check();
          this.display();
        }),
      );
    status.settingEl.addClass(`tc-reader-${tts.reader.status}`);
    new Setting(el)
      .setName("Access token")
      .setDesc("In Reader: Settings → Text-to-speech → turn on “Let Talking Cards use my voices”, tap Copy, paste here.")
      .addText((t) => {
        t.setPlaceholder("Paste token").setValue(tts.prefs.readerToken).onChange((v) => {
          tts.prefs.readerToken = v.trim();
          tts.savePrefs();
        });
        t.inputEl.addEventListener("blur", () => void tts.reader.check().then(() => this.display()));
      });
  }

  private voiceSection(el: HTMLElement) {
    const tts = this.plugin.tts;
    const s = this.plugin.settings;
    new Setting(el).setName("Voice").setHeading();

    const installed = tts.installedPiper();
    new Setting(el)
      .setName("Voice store")
      .setDesc(
        installed.length
          ? `On this device: ${installed.map((v) => `${voiceName(v.name)} (${speedLabel(v).toLowerCase()})`).join(", ")}`
          : "No voices downloaded on this device yet. Download one to hear cards read aloud.",
      )
      .addButton((b) =>
        b
          .setButtonText(installed.length ? "Manage voices" : "Get a voice")
          .setCta()
          .onClick(() => new VoiceStoreModal(this.app, tts, () => this.display()).open()),
      );

    if (Platform.isMobile) this.readerSection(el);

    const options: [string, string][] = [["", "Automatic"]];
    for (const v of tts.reader.voices) options.push([`reader:${v.id}`, `${v.name} — phone`]);
    for (const v of installed) options.push([`piper:${v.key}`, `${voiceName(v.name)} — ${v.langName}`]);
    for (const v of tts.systemVoices()) options.push([`system:${v.voiceURI}`, `${v.name} (system)`]);
    const auto = tts.describe(tts.resolve(""));
    const pick = (name: string, side: "front" | "back") =>
      new Setting(el)
        .setName(name)
        .setDesc(`This device only. Automatic currently means: ${auto}. A note can override with tts-${side}: es (any language) in its frontmatter.`)
        .addDropdown((d) => {
          for (const [v, label] of options) d.addOption(v, label);
          d.setValue(options.some(([v]) => v === tts.prefs[side]) ? tts.prefs[side] : "");
          d.onChange((v) => {
            tts.prefs[side] = v;
            tts.savePrefs();
          });
        })
        .addExtraButton((b) =>
          b
            .setIcon("play")
            .setTooltip("Play a sample")
            .onClick(() => {
              tts.unlock();
              tts.speak(side === "front" ? "What is the powerhouse of the cell?" : "The mitochondria.", tts.prefs[side]).catch((e: unknown) => new Notice(e instanceof Error ? e.message : String(e)));
            }),
        );
    pick("Question voice", "front");
    pick("Answer voice", "back");

    new Setting(el)
      .setName("Speed")
      .setDesc("This device only.")
      .addSlider((sl) =>
        sl.setLimits(0.5, 2, 0.05).setValue(tts.prefs.speed).setDynamicTooltip().onChange((v) => {
          tts.prefs.speed = v;
          tts.savePrefs();
        }),
      );
    new Setting(el)
      .setName("Read questions aloud automatically")
      .addToggle((t) => t.setValue(s.autoReadFront).onChange((v) => ((s.autoReadFront = v), this.plugin.saveSettings("none"))));
    new Setting(el)
      .setName("Read answers aloud automatically")
      .addToggle((t) => t.setValue(s.autoReadBack).onChange((v) => ((s.autoReadBack = v), this.plugin.saveSettings("none"))));

    new Setting(el).setName("Audio mode").setHeading().setDesc("The 🎧 button while reviewing: reads the question, waits, reads the answer, then shows big grade buttons.");
    num(el, "Thinking time (seconds)", "Pause between question and answer. 0 = wait until you tap.", s.audioThinkSeconds, (v) => ((s.audioThinkSeconds = v), this.plugin.saveSettings("none")));
    num(
      el,
      "Auto-grade Good after (seconds)",
      "Fully hands-free: counts the card as Good if you don't tap. 0 = off. Only use this if you really listen — it trusts you.",
      s.audioAutoGoodSeconds,
      (v) => ((s.audioAutoGoodSeconds = v), this.plugin.saveSettings("none")),
    );
    new Setting(el)
      .setName("Keep screen on")
      .setDesc("While audio mode is on.")
      .addToggle((t) => t.setValue(s.keepAwake).onChange((v) => ((s.keepAwake = v), this.plugin.saveSettings("none"))));

    // Size known from startup. Don't update the row later: on mobile, changing a setting's text after
    // the tab opened makes Obsidian redraw the whole tab, and the update would run again, forever.
    const used = tts.piper.cacheBytes;
    const cache = new Setting(el)
      .setName("Audio cache")
      .setDesc(`${used === null ? "" : `${formatBytes(used)} of ${s.audioCacheMb} MB used. `}Cards are spoken once and kept, so repeats play instantly.`);
    cache
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.addClass("tc-input-narrow");
        t.setValue(String(s.audioCacheMb)).onChange((v) => {
          const n = Number(v);
          if (n >= 10) {
            s.audioCacheMb = n;
            tts.piper.cacheLimit = n * 1024 * 1024;
            void this.plugin.saveSettings("none");
          }
        });
      })
      .addButton((b) =>
        b.setButtonText("Clear").onClick(async () => {
          await tts.piper.clearCache();
          this.display();
        }),
      );
  }
}

function num(el: HTMLElement, name: string, desc: string, value: number, set: (v: number) => unknown) {
  new Setting(el)
    .setName(name)
    .setDesc(desc)
    .addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(value)).onChange((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) void set(n);
      });
    });
}

function steps(v: string, fallback: string[]): string[] {
  const out = v.split(/[\s,]+/).filter((x) => /^\d+(\.\d+)?[mhd]$/.test(x));
  if (!out.length) new Notice("Steps look like: 1m 10m");
  return out.length ? out : fallback;
}

/** A sample revealed card styled like the review screen; call the returned function to restyle it. */
function cardPreview(parent: HTMLElement): (s: ReviewSettings) => void {
  const box = parent.createDiv({ cls: "tc-preview tc-review" });
  const card = box.createDiv({ cls: "tc-card" });
  const ctx = card.createDiv({ cls: "tc-context", text: "Biology › Cells" });
  const front = card.createDiv({ cls: "tc-side tc-front", text: "What does the mitochondrion do?" });
  const hr = card.createEl("hr", { cls: "tc-divider" });
  card.createDiv({ cls: "tc-side tc-back", text: "It makes ATP — the cell's energy — by aerobic respiration." });
  return (s) => {
    box.setCssProps({ "--tc-card-size": `${s.cardTextSize}em` });
    box.toggleClass("tc-align-center", s.cardAlign === "center");
    ctx.toggle(s.showContext);
    front.toggle(s.keepQuestion);
    hr.toggle(s.keepQuestion);
  };
}
