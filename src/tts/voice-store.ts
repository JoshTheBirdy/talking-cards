import { Modal, Notice, setIcon, type App } from "obsidian";
import type { Tts } from "./tts.ts";
import { RECOMMENDED, formatBytes, type CatalogueVoice, type InstalledVoice } from "./piper-engine.ts";

const QUALITY_NOTE: Record<string, string> = {
  x_low: "lowest quality",
  low: "low quality",
  medium: "",
  high: "high quality, slower",
};

/** Browse, download, test and delete built-in voices. Downloads are per device. */
export class VoiceStoreModal extends Modal {
  private catalogue: CatalogueVoice[] = [];
  private filter = "";
  private showAll = false;
  private busy = new Map<string, { label: string; pct: number; abort: AbortController }>();
  private listEl!: HTMLElement;

  constructor(app: App, private tts: Tts, private onChange: () => void) {
    super(app);
  }

  async onOpen() {
    this.modalEl.addClass("tc-voice-store");
    this.titleEl.setText("Voice store");
    const { contentEl } = this;
    contentEl.createEl("p", {
      cls: "tc-muted",
      text: "Natural voices that run on this device, offline once downloaded. Each is about 60 MB and stays on this device only — it doesn't sync.",
    });
    const bar = contentEl.createDiv({ cls: "tc-store-bar" });
    const search = bar.createEl("input", { type: "search", placeholder: "Search language or name…" });
    search.oninput = () => {
      this.filter = search.value.toLowerCase();
      this.renderList();
    };
    const all = bar.createEl("label", { cls: "tc-store-all" });
    const cb = all.createEl("input", { type: "checkbox" });
    all.appendText(" Show all");
    cb.onchange = () => {
      this.showAll = cb.checked;
      this.renderList();
    };
    this.listEl = contentEl.createDiv({ cls: "tc-store-list" });
    this.listEl.setText("Loading voice list…");
    try {
      this.catalogue = Object.values(await this.tts.piper.catalogue());
    } catch (e) {
      this.listEl.setText(`Couldn't load the voice list: ${(e as Error).message}. Check your connection.`);
      return;
    }
    this.renderList();
  }

  onClose() {
    for (const b of this.busy.values()) b.abort.abort();
  }

  private visible(): CatalogueVoice[] {
    const f = this.filter;
    return this.catalogue.filter((v) => {
      if (f) {
        const hay = `${v.key} ${v.name} ${v.language.name_english} ${v.language.country_english} ${v.language.name_native ?? ""}`.toLowerCase();
        return hay.includes(f);
      }
      if (this.showAll) return true;
      return RECOMMENDED.includes(v.key) || this.tts.piper.installed.has(v.key) || this.busy.has(v.key);
    });
  }

  private renderList() {
    const el = this.listEl;
    el.empty();
    const voices = this.visible();
    if (!voices.length) {
      el.createEl("p", { cls: "tc-muted", text: "No voices match." });
      return;
    }
    if (!this.filter && !this.showAll) el.createEl("p", { cls: "tc-muted", text: "Recommended voices. Search or tick “Show all” for 40+ languages." });

    const groups = new Map<string, CatalogueVoice[]>();
    for (const v of voices) {
      const g = `${v.language.name_english} (${v.language.country_english})`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(v);
    }
    for (const [lang, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      el.createEl("h4", { cls: "tc-store-lang", text: lang });
      list.sort((a, b) => Number(RECOMMENDED.includes(b.key)) - Number(RECOMMENDED.includes(a.key)) || a.name.localeCompare(b.name));
      for (const v of list) this.renderVoice(el, v);
    }
  }

  private renderVoice(parent: HTMLElement, v: CatalogueVoice) {
    const row = parent.createDiv({ cls: "tc-store-row" });
    const info = row.createDiv({ cls: "tc-store-info" });
    const name = info.createDiv({ cls: "tc-store-name", text: voiceName(v.name) });
    if (RECOMMENDED.includes(v.key)) name.createSpan({ cls: "tc-badge", text: "Recommended" });
    const size = Object.entries(v.files).find(([p]) => p.endsWith(".onnx"))?.[1].size_bytes ?? 0;
    const bits = [formatBytes(size), QUALITY_NOTE[v.quality], v.num_speakers > 1 ? `${v.num_speakers} speakers` : ""].filter(Boolean);
    const inst = this.tts.piper.installed.get(v.key);
    if (inst) bits.unshift(speedLabel(inst));
    info.createDiv({ cls: "tc-muted tc-store-meta", text: bits.join(" · ") });

    const actions = row.createDiv({ cls: "tc-store-actions" });
    const job = this.busy.get(v.key);
    if (job) {
      actions.createSpan({ cls: "tc-muted", text: `${job.label} ${job.pct}%` });
      const cancel = actions.createEl("button", { text: "Cancel" });
      cancel.onclick = () => job.abort.abort();
      return;
    }
    if (inst) {
      const play = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Play a sample" } });
      setIcon(play, "play");
      play.onclick = () => this.sample(inst);
      const del = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete from this device" } });
      setIcon(del, "trash-2");
      del.onclick = async () => {
        await this.tts.piper.remove(v.key);
        new Notice(`Deleted ${voiceName(v.name)}`);
        this.onChange();
        this.renderList();
      };
    } else {
      const get = actions.createEl("button", { cls: "mod-cta", text: "Download" });
      get.onclick = () => this.install(v);
    }
  }

  private async install(v: CatalogueVoice) {
    const abort = new AbortController();
    const job = { label: "Starting", pct: 0, abort };
    this.busy.set(v.key, job);
    this.renderList();
    let last = 0;
    try {
      await this.tts.piper.install(
        v,
        (what, loaded, total) => {
          job.label = what;
          job.pct = total ? Math.floor((loaded / total) * 100) : 0;
          if (Date.now() - last > 250) {
            last = Date.now();
            this.renderList();
          }
        },
        abort.signal,
      );
      const inst = this.tts.piper.installed.get(v.key)!;
      new Notice(`${voiceName(v.name)} is ready — ${speedLabel(inst).toLowerCase()} on this device`);
      this.onChange();
    } catch (e) {
      if (!abort.signal.aborted) new Notice(`Couldn't install ${voiceName(v.name)}: ${(e as Error).message}`, 10_000);
    } finally {
      this.busy.delete(v.key);
      this.renderList();
    }
  }

  private async sample(v: InstalledVoice) {
    this.tts.unlock();
    try {
      await this.tts.speak(`Hello, I'm ${voiceName(v.name)}. This is how your flashcards will sound.`, `piper:${v.key}`);
    } catch (e) {
      new Notice((e as Error).message);
    }
  }
}

export function speedLabel(v: InstalledVoice): string {
  if (v.rtf === undefined) return "Installed";
  if (v.rtf < 0.5) return "Fast";
  if (v.rtf < 1) return "Keeps up";
  return "Slow here — cards are prepared ahead";
}

/** "northern_english_male" → "Northern English Male" */
export function voiceName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
