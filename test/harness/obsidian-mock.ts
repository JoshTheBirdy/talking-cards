// A small stand-in for the Obsidian API, enough to run the real plugin in a browser page.
// Used only by test/harness (UI click-through without Obsidian). Not part of the plugin.

// ---------- DOM helpers Obsidian adds to HTMLElement ----------
type ElOpts = { cls?: string | string[]; text?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string } | string;
const P = HTMLElement.prototype as unknown as Record<string, unknown>;
P.createEl = function (this: HTMLElement, tag: string, o: ElOpts = {}) {
  const e = document.createElement(tag) as HTMLElement & Record<string, unknown>;
  if (typeof o === "string") o = { cls: o };
  if (o.cls) e.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  if (o.text != null) e.textContent = o.text;
  for (const k of ["type", "value", "placeholder"] as const) if (o[k] != null) e[k] = o[k];
  if (o.attr) for (const k in o.attr) e.setAttribute(k, o.attr[k]);
  this.appendChild(e);
  return e;
};
(window as any).createSpan = (o: ElOpts = {}) => (document.createElement("div") as any).createSpan(o);
(window as any).createDiv = (o: ElOpts = {}) => (document.createElement("div") as any).createDiv(o);
P.createDiv = function (this: HTMLElement & { createEl: Function }, o: ElOpts = {}) { return this.createEl("div", o); };
P.createSpan = function (this: HTMLElement & { createEl: Function }, o: ElOpts = {}) { return this.createEl("span", o); };
P.empty = function (this: HTMLElement) { this.innerHTML = ""; };
P.addClass = function (this: HTMLElement, ...c: string[]) { this.classList.add(...c); };
P.removeClass = function (this: HTMLElement, ...c: string[]) { this.classList.remove(...c); };
P.toggleClass = function (this: HTMLElement, c: string, v: boolean) { this.classList.toggle(c, v); };
P.setText = function (this: HTMLElement, t: string) { this.textContent = t; };
P.appendText = function (this: HTMLElement, t: string) { this.append(t); };
P.toggle = function (this: HTMLElement, show: boolean) { this.style.display = show ? "" : "none"; };
P.setCssStyles = function (this: HTMLElement, st: Record<string, string>) { Object.assign(this.style, st); };
P.setCssProps = function (this: HTMLElement, props: Record<string, string>) { for (const k in props) this.style.setProperty(k, props[k]); };
P.hide = function (this: HTMLElement) { this.style.display = "none"; };
P.show = function (this: HTMLElement) { this.style.display = ""; };
P.isShown = function (this: HTMLElement) { return this.style.display !== "none"; };

// ---------- basics ----------
export const Platform = {
  isMobile: new URLSearchParams(location.search).has("mobile"),
  isAndroidApp: new URLSearchParams(location.search).has("mobile"),
  isIosApp: false, isMacOS: false, isWin: false, isLinux: true, isDesktop: !new URLSearchParams(location.search).has("mobile"),
};
if (Platform.isMobile) document.body.classList.add("is-mobile", "is-phone");

export function normalizePath(p: string) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

const ICONS: Record<string, string> = {
  "arrow-left": "←", "undo-2": "↶", pencil: "✎", clock: "⏱", pause: "⏸", play: "▶", "volume-2": "🔊", headphones: "🎧",
  "chevron-down": "▾", "chevron-right": "▸", layers: "🗂", "trash-2": "🗑", "rotate-ccw": "↺", x: "✕",
};
export function setIcon(el: HTMLElement, name: string) {
  el.textContent = ICONS[name] ?? `[${name}]`;
}

/** requestUrl via fetch (the real one uses native HTTP and skips CORS). */
export async function requestUrl(r: { url: string; method?: string; headers?: Record<string, string>; body?: string; throw?: boolean }) {
  const res = await fetch(r.url, { method: r.method ?? "GET", headers: r.headers, body: r.body });
  const arrayBuffer = await res.arrayBuffer();
  return { status: res.status, arrayBuffer, text: new TextDecoder().decode(arrayBuffer), json: null };
}

export class Notice {
  constructor(msg: string, ms = 4000) {
    const host = document.getElementById("notices")!;
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = msg;
    host.appendChild(n);
    (window as any).__notices = [...((window as any).__notices ?? []), msg];
    setTimeout(() => n.remove(), ms);
  }
}

type Ref = { name: string; fn: Function; owner: Events };
export class Events {
  private handlers = new Map<string, Ref[]>();
  on(name: string, fn: Function): Ref {
    const r = { name, fn, owner: this };
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), r]);
    return r;
  }
  offref(r: Ref) {
    this.handlers.set(r.name, (this.handlers.get(r.name) ?? []).filter((x) => x !== r));
  }
  trigger(name: string, ...args: unknown[]) {
    for (const r of this.handlers.get(name) ?? []) r.fn(...args);
  }
}

export class Component {
  private children: Component[] = [];
  private cleanups: (() => void)[] = [];
  load() {}
  onload() {}
  unload() {
    this.children.forEach((c) => c.unload());
    this.cleanups.forEach((f) => f());
    this.cleanups = [];
  }
  addChild<T extends Component>(c: T): T {
    this.children.push(c);
    return c;
  }
  register(f: () => void) { this.cleanups.push(f); }
  registerEvent(r: Ref) { this.cleanups.push(() => r.owner.offref(r)); }
  registerInterval(id: number) { this.cleanups.push(() => clearInterval(id)); return id; }
  registerDomEvent(el: EventTarget, ev: string, fn: EventListener) {
    el.addEventListener(ev, fn);
    this.cleanups.push(() => el.removeEventListener(ev, fn));
  }
}

// ---------- vault ----------
export class TFolder {
  constructor(public path: string) {}
  get name() { return this.path.split("/").pop()!; }
}
export class TFile {
  stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  constructor(public path: string) {}
  get name() { return this.path.split("/").pop()!; }
  get basename() { return this.name.replace(/\.[^.]+$/, ""); }
  get extension() { return this.name.split(".").pop()!; }
  get parent() { const i = this.path.lastIndexOf("/"); return new TFolder(i < 0 ? "/" : this.path.slice(0, i)); }
}

class Vault extends Events {
  files = new Map<string, { file: TFile; text: string }>();
  /** Plugin-folder files (outside the vault's notes), kept in localStorage. */
  adapter = {
    read: async (p: string) => {
      const v = localStorage.getItem(`adapter:${p}`);
      if (v === null) throw new Error(`ENOENT ${p}`);
      return v;
    },
    write: async (p: string, d: string) => localStorage.setItem(`adapter:${p}`, d),
  };
  folders = new Set<string>();
  constructor(private app: App) { super(); }
  seed(files: Record<string, string>) {
    for (const [p, t] of Object.entries(files)) this.files.set(p, { file: new TFile(p), text: t });
  }
  getName() { return "test-vault"; }
  getFiles() { return [...this.files.values()].map((f) => f.file); }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === "md"); }
  getAbstractFileByPath(p: string) { return this.files.get(p)?.file ?? (this.folders.has(p) ? new TFolder(p) : null); }
  getResourcePath(f: TFile) { return `../../test-vault/${encodeURI(f.path)}`; }
  async read(f: TFile) { return this.files.get(f.path)!.text; }
  async cachedRead(f: TFile) { return this.files.get(f.path)!.text; }
  private write(f: TFile, text: string) {
    this.files.get(f.path)!.text = text;
    f.stat.mtime = Date.now();
    this.trigger("modify", f);
    this.app.metadataCache.update(f);
  }
  async modify(f: TFile, text: string) { this.write(f, text); }
  async process(f: TFile, fn: (t: string) => string) { const t = fn(this.files.get(f.path)!.text); this.write(f, t); return t; }
  async create(p: string, text: string) {
    if (this.files.has(p)) throw new Error("File already exists");
    const file = new TFile(p);
    this.files.set(p, { file, text });
    this.trigger("create", file);
    this.app.metadataCache.update(file);
    return file;
  }
  async createFolder(p: string) { this.folders.add(p); }
}

class MetadataCache extends Events {
  constructor(private app: App) { super(); }
  getFirstLinkpathDest(link: string, _src: string) {
    const files = this.app.vault.getFiles();
    return files.find((f) => f.path === link) ?? files.find((f) => f.path.endsWith("/" + link)) ?? null;
  }
  getFileCache(f: TFile) {
    const text = this.app.vault.files.get(f.path)?.text ?? "";
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) return {};
    const fm: Record<string, unknown> = {};
    for (const line of m[1].split("\n")) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2] === "false" ? false : kv[2] === "true" ? true : kv[2];
    }
    return { frontmatter: fm };
  }
  update(f: TFile) { setTimeout(() => this.trigger("changed", f), 0); }
}

// ---------- workspace ----------
export class WorkspaceLeaf {
  view: ItemView | { getViewType(): string } = { getViewType: () => "empty" };
  tabEl: HTMLElement;
  containerEl: HTMLElement;
  constructor(private ws: Workspace) {
    this.containerEl = document.getElementById("main")!.createDiv({ cls: "workspace-leaf" });
    this.tabEl = document.getElementById("tabs")!.createDiv({ cls: "tab", text: "New tab" });
    this.tabEl.onclick = () => ws.revealLeaf(this);
  }
  async setViewState(s: { type: string; active?: boolean; state?: Record<string, unknown> }) {
    if (this.view instanceof ItemView) { await this.view.onClose(); this.view.unload(); }
    this.containerEl.empty();
    const make = this.ws.app.viewFactories.get(s.type);
    if (!make) throw new Error(`No view ${s.type}`);
    const v = make(this);
    this.view = v;
    this.containerEl.appendChild(v.containerEl);
    this.tabEl.textContent = v.getDisplayText();
    await v.onOpen();
    await v.setState(s.state ?? {}, { history: false });
    this.tabEl.textContent = v.getDisplayText();
    if (s.active) this.ws.revealLeaf(this);
  }
  async openFile(f: TFile, o?: { eState?: { line?: number } }) {
    this.containerEl.empty();
    this.view = { getViewType: () => "markdown" };
    this.tabEl.textContent = f.basename;
    const pre = this.containerEl.createEl("pre", { cls: "fake-editor" });
    const lines = (this.ws.app.vault.files.get(f.path)?.text ?? "").split("\n");
    lines.forEach((l, i) => pre.createDiv({ cls: i === o?.eState?.line ? "line is-target" : "line", text: l || " " }));
    this.ws.active = this;
    this.ws.activeFile = f;
    this.ws.revealLeaf(this);
  }
}

class Workspace extends Events {
  leaves: WorkspaceLeaf[] = [];
  active: WorkspaceLeaf | null = null;
  activeFile: TFile | null = null;
  constructor(public app: App) { super(); }
  getLeaf(_kind?: string) { const l = new WorkspaceLeaf(this); this.leaves.push(l); return l; }
  getLeavesOfType(t: string) { return this.leaves.filter((l) => l.view.getViewType() === t); }
  async revealLeaf(l: WorkspaceLeaf) {
    this.active = l;
    for (const x of this.leaves) {
      x.containerEl.style.display = x === l ? "" : "none";
      x.tabEl.classList.toggle("is-active", x === l);
    }
  }
  getActiveFile() { return this.activeFile; }
  onLayoutReady(fn: () => void) { setTimeout(fn, 0); }
}

export class Scope {
  keys: { mods: string[]; key: string; fn: (e: KeyboardEvent) => unknown }[] = [];
  constructor(public parent?: Scope) {}
  register(mods: string[], key: string, fn: (e: KeyboardEvent) => unknown) { this.keys.push({ mods, key, fn }); }
}

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace: Workspace;
  scope = new Scope();
  viewFactories = new Map<string, (l: WorkspaceLeaf) => ItemView>();
  constructor() {
    this.vault = new Vault(this);
    this.metadataCache = new MetadataCache(this);
    this.workspace = new Workspace(this);
    document.addEventListener("keydown", (e) => {
      const v = this.workspace.active?.view;
      if (!(v instanceof ItemView) || !v.scope || (e.target as HTMLElement).matches("input, textarea, select")) return;
      for (const k of v.scope.keys) {
        const mod = k.mods.includes("Mod");
        if ((k.key === e.key || (k.key === "Space" && e.key === " ")) && mod === (e.ctrlKey || e.metaKey)) {
          k.fn(e);
          return;
        }
      }
    });
  }
  loadLocalStorage(k: string) { const v = localStorage.getItem(`ls:${k}`); return v ? JSON.parse(v) : null; }
  saveLocalStorage(k: string, v: unknown) { localStorage.setItem(`ls:${k}`, JSON.stringify(v)); }
}

// ---------- views, plugin, settings ----------
export class ItemView extends Component {
  app: App;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  scope: Scope | null = null;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = (leaf as unknown as { ws: Workspace }).ws.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "view-container";
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }
  getViewType() { return ""; }
  getDisplayText() { return ""; }
  getIcon() { return ""; }
  getState() { return {}; }
  async setState(_s: unknown, _r: unknown) {}
  async onOpen() {}
  async onClose() {}
}
export type ViewStateResult = { history: boolean };

export class Plugin extends Component {
  manifest = { id: "talking-cards", dir: ".obsidian/plugins/talking-cards" };
  constructor(public app: App) { super(); }
  async loadData() { const v = localStorage.getItem("plugin-data"); return v ? JSON.parse(v) : null; }
  async saveData(d: unknown) { localStorage.setItem("plugin-data", JSON.stringify(d)); }
  registerMarkdownCodeBlockProcessor(lang: string, fn: (src: string, el: HTMLElement, ctx: unknown) => void) { (window as any).__codeBlocks = { ...((window as any).__codeBlocks ?? {}), [lang]: fn }; }
  registerView(type: string, f: (l: WorkspaceLeaf) => ItemView) { this.app.viewFactories.set(type, f); }
  addRibbonIcon(icon: string, title: string, fn: () => void) {
    const b = document.getElementById("ribbon")!.createEl("button", { text: ICONS[icon] ?? icon, attr: { "aria-label": title, title } });
    b.onclick = fn;
    return b;
  }
  addStatusBarItem() { return document.getElementById("status")!.createDiv({ cls: "status-item" }); }
  addCommand(c: { id: string; name: string; callback?: () => void; checkCallback?: (checking: boolean) => boolean }) {
    const b = document.getElementById("commands")!.createEl("button", { text: c.name, attr: { "data-cmd": c.id } });
    b.onclick = () => (c.callback ? c.callback() : c.checkCallback?.(false));
  }
  addSettingTab(t: PluginSettingTab) {
    (window as any).__settingTab = t;
    const b = document.getElementById("ribbon")!.createEl("button", { text: "⚙", attr: { "aria-label": "Settings", title: "Settings" } });
    b.onclick = () => openSettings(t);
  }
}

function openSettings(t: PluginSettingTab) {
  const m = new Modal(t.app);
  m.titleEl.setText("Talking Cards settings");
  t.containerEl = m.contentEl;
  m.modalEl.addClass("mod-settings");
  m.open();
  t.display();
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement("div");
  constructor(public app: App, public plugin: Plugin) {}
  display() {}
}

export class Modal {
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  private bg: HTMLElement;
  constructor(public app: App) {
    this.bg = document.createElement("div");
    this.bg.className = "modal-container";
    this.modalEl = this.bg.createDiv({ cls: "modal" });
    const close = this.modalEl.createEl("button", { cls: "modal-close", text: "✕" });
    close.onclick = () => this.close();
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  open() { document.body.appendChild(this.bg); void this.onOpen(); }
  close() { this.onClose(); this.bg.remove(); }
  onOpen(): void | Promise<void> {}
  onClose() {}
}

export class FuzzySuggestModal<T> extends Modal {
  emptyStateText = "No results";
  private placeholder = "";
  setPlaceholder(p: string) { this.placeholder = p; }
  getItems(): T[] { return []; }
  getItemText(_t: T): string { return ""; }
  onChooseItem(_t: T) {}
  onOpen() {
    const input = this.contentEl.createEl("input", { type: "text", placeholder: this.placeholder, cls: "tc-fuzzy" });
    const list = this.contentEl.createDiv({ cls: "suggestion-container" });
    const draw = () => {
      list.empty();
      const q = input.value.toLowerCase();
      const items = this.getItems().filter((i) => this.getItemText(i).toLowerCase().includes(q));
      if (!items.length) list.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
      for (const i of items) {
        const row = list.createDiv({ cls: "suggestion-item", text: this.getItemText(i) });
        row.onclick = () => { this.close(); this.onChooseItem(i); };
      }
    };
    input.oninput = draw;
    draw();
  }
}

class Chain {
  constructor(public el: HTMLElement) {}
}
class ToggleC extends Chain {
  input = this.el.createEl("input", { type: "checkbox" }) as HTMLInputElement;
  setValue(v: boolean) { this.input.checked = v; return this; }
  onChange(f: (v: boolean) => unknown) { this.input.onchange = () => f(this.input.checked); return this; }
}
class TextC extends Chain {
  inputEl: HTMLInputElement | HTMLTextAreaElement;
  constructor(el: HTMLElement, area = false) { super(el); this.inputEl = el.createEl(area ? "textarea" : "input", area ? {} : { type: "text" }) as HTMLInputElement; }
  setValue(v: string) { this.inputEl.value = v; return this; }
  setPlaceholder(v: string) { this.inputEl.placeholder = v; return this; }
  onChange(f: (v: string) => unknown) { this.inputEl.oninput = () => f(this.inputEl.value); return this; }
}
class DropdownC extends Chain {
  selectEl = this.el.createEl("select", { cls: "dropdown" }) as HTMLSelectElement;
  addOption(v: string, t: string) { this.selectEl.createEl("option", { value: v, text: t }); return this; }
  addOptions(o: Record<string, string>) { for (const [v, t] of Object.entries(o)) this.addOption(v, t); return this; }
  setValue(v: string) { this.selectEl.value = v; return this; }
  onChange(f: (v: string) => unknown) { this.selectEl.onchange = () => f(this.selectEl.value); return this; }
}
class SliderC extends Chain {
  input = this.el.createEl("input", { type: "range" }) as HTMLInputElement;
  setLimits(a: number, b: number, s: number) { Object.assign(this.input, { min: a, max: b, step: s }); return this; }
  setValue(v: number) { this.input.value = String(v); return this; }
  setDynamicTooltip() { return this; }
  onChange(f: (v: number) => unknown) { this.input.oninput = () => f(Number(this.input.value)); return this; }
}
class ButtonC extends Chain {
  buttonEl = this.el.createEl("button") as HTMLButtonElement;
  setButtonText(t: string) { this.buttonEl.textContent = t; return this; }
  setCta() { this.buttonEl.classList.add("mod-cta"); return this; }
  setDisabled(d: boolean) { this.buttonEl.disabled = d; return this; }
  setIcon(i: string) { setIcon(this.buttonEl, i); return this; }
  setTooltip(t: string) { this.buttonEl.title = t; return this; }
  onClick(f: () => unknown) { this.buttonEl.onclick = () => f(); return this; }
}

export class Setting {
  settingEl: HTMLElement;
  private nameEl: HTMLElement;
  private descEl: HTMLElement;
  private controlEl: HTMLElement;
  constructor(parent: HTMLElement) {
    this.settingEl = parent.createDiv({ cls: "setting-item" });
    const info = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = info.createDiv({ cls: "setting-item-name" });
    this.descEl = info.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(n: string) { this.nameEl.textContent = n; return this; }
  setDesc(d: string) { this.descEl.textContent = d; return this; }
  setHeading() { this.settingEl.classList.add("setting-item-heading"); return this; }
  addToggle(f: (c: ToggleC) => unknown) { f(new ToggleC(this.controlEl)); return this; }
  addText(f: (c: TextC) => unknown) { f(new TextC(this.controlEl)); return this; }
  addTextArea(f: (c: TextC) => unknown) { f(new TextC(this.controlEl, true)); return this; }
  addDropdown(f: (c: DropdownC) => unknown) { f(new DropdownC(this.controlEl)); return this; }
  addSlider(f: (c: SliderC) => unknown) { f(new SliderC(this.controlEl)); return this; }
  addButton(f: (c: ButtonC) => unknown) { f(new ButtonC(this.controlEl)); return this; }
  addExtraButton(f: (c: ButtonC) => unknown) { f(new ButtonC(this.controlEl)); return this; }
}

/** Tiny Markdown: paragraphs, lists, bold/italic, highlights, wikilinks, inline HTML kept. */
export class MarkdownView { file: TFile | null = null; }
export class Menu { addItem(_f: unknown) { return this; } }

export const MarkdownRenderer = {
  async render(_app: App, md: string, el: HTMLElement, _src: string, _c: Component) {
    const inline = (s: string) =>
      s.replace(/!\[\[([^\]|]+)[^\]]*\]\]/g, (_m, l: string) => { const f = (window as any).app.metadataCache.getFirstLinkpathDest(l, ""); return f ? `<span class="internal-embed image-embed"><img src="${(window as any).app.vault.getResourcePath(f)}"></span>` : ""; }).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/==(.+?)==/g, "<mark>$1</mark>").replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "<a>$2</a>").replace(/`([^`]+)`/g, "<code>$1</code>");
    let html = "";
    let inList = false;
    for (const line of md.split("\n")) {
      const li = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (li) {
        if (!inList) html += "<ul>";
        inList = true;
        html += `<li>${inline(li[1])}</li>`;
      } else {
        if (inList) html += "</ul>";
        inList = false;
        if (line.trim()) html += `<p>${inline(line)}</p>`;
      }
    }
    if (inList) html += "</ul>";
    el.innerHTML = html;
  },
};
