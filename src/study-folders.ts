import { TFile, normalizePath } from "obsidian";
import type TalkingCards from "./main.ts";
import { ACTIVITY_FILE, formatRules, parseRules, toggle } from "./activity.ts";

/**
 * Keeps the on/off switches for studying in a note (study-folders.md) next to the review logs,
 * so Sync carries them to every device. Found wherever it is, like the logs.
 */
export class StudyFolders {
  private reloadTimer: number | null = null;

  constructor(private plugin: TalkingCards) {}

  private file(): TFile | null {
    const { vault } = this.plugin.app;
    const here = vault.getAbstractFileByPath(normalizePath(`${this.plugin.settings.dataFolder}/${ACTIVITY_FILE}`));
    if (here instanceof TFile) return here;
    return vault.getFiles().find((f) => f.name === ACTIVITY_FILE && !f.path.startsWith(".trash/") && !f.path.startsWith(vault.configDir + "/")) ?? null;
  }

  async load() {
    const f = this.file();
    this.plugin.index.setRules(f ? parseRules(await this.plugin.app.vault.read(f)) : new Map<string, boolean>());
  }

  /** The note changed (edited here or synced in): reload shortly. */
  onFileChanged(file: { name: string }) {
    if (file.name !== ACTIVITY_FILE) return;
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    this.reloadTimer = window.setTimeout(() => void this.load(), 300);
  }

  /** A folder or note was renamed or moved: its switch (and those inside it) follow. */
  async onRenamed(oldPath: string, newPath: string) {
    const rules = this.plugin.index.studyRules;
    const moved = new Map<string, boolean>();
    let hit = false;
    for (const [p, on] of rules) {
      if (p === oldPath || p.startsWith(oldPath + "/")) {
        moved.set(newPath + p.slice(oldPath.length), on);
        hit = true;
      } else moved.set(p, on);
    }
    if (hit) await this.save(moved);
  }

  /** Switches a folder or note on or off for studying. */
  async toggle(path: string) {
    await this.save(toggle(this.plugin.index.studyRules, path));
  }

  private async save(next: Map<string, boolean>) {
    this.plugin.index.setRules(next);
    const text = formatRules(next);
    const { vault } = this.plugin.app;
    const f = this.file();
    if (f) {
      await vault.process(f, () => text);
      return;
    }
    const dir = normalizePath(this.plugin.settings.dataFolder);
    if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => {});
    await vault.create(normalizePath(`${dir}/${ACTIVITY_FILE}`), text);
  }
}
