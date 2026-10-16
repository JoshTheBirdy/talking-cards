import { MarkdownView, Menu, Modal, Notice, Setting, TFile, setIcon, type App, type Editor, type MarkdownPostProcessorContext } from "obsidian";
import type TalkingCards from "./main.ts";
import { formatOcclusionBlock, imagesOnLine, newBoxId, parseOcclusion, type Occlusion, type OcclusionBox } from "./occlusion.ts";

/** The image's file, resolved like a wikilink from the note it's in. */
export function imageFile(app: App, link: string, sourcePath: string): TFile | null {
  const f = app.metadataCache.getFirstLinkpathDest(link, sourcePath);
  return f instanceof TFile ? f : null;
}

type Look = "question" | "answer" | "overview";

/**
 * The image with its boxes. `question`: the asked box covered (and, in hide-all, the others too).
 * `answer`: the asked box uncovered and labelled. `overview`: every box outlined with its label.
 */
export function drawOcclusion(parent: HTMLElement, app: App, o: Occlusion, sourcePath: string, look: Look, target?: string): HTMLElement {
  const wrap = parent.createDiv({ cls: `tc-occ tc-occ-look-${look}` });
  const file = imageFile(app, o.image, sourcePath);
  if (!file) {
    wrap.createDiv({ cls: "tc-occ-missing", text: `Image not found: ${o.image}` });
    return wrap;
  }
  wrap.createEl("img", { attr: { src: app.vault.getResourcePath(file), alt: o.image, draggable: "false" } });
  o.boxes.forEach((b, i) => {
    const asked = b.id === target;
    let cls = "tc-occ-box";
    if (look === "overview") cls += " is-outline";
    else if (asked) cls += look === "question" ? " is-asked" : " is-revealed";
    else if (o.mode === "hide-all") cls += " is-covered";
    else cls += " is-shown";
    const el = wrap.createDiv({ cls });
    place(el, b);
    if (look === "question" && asked) el.setText("?");
    if ((look === "answer" && asked) || look === "overview") el.createSpan({ cls: "tc-occ-label", text: b.label || String(i + 1) });
  });
  return wrap;
}

function place(el: HTMLElement, b: { x: number; y: number; w: number; h: number }) {
  el.setCssStyles({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
}

/** Full-screen view of an image (or an occlusion); double-tap or the button toggles 2×. */
export class ZoomModal extends Modal {
  constructor(app: App, private source: HTMLElement) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("tc-zoom-modal");
    const stage = this.contentEl.createDiv({ cls: "tc-zoom" });
    const copy = this.source.cloneNode(true) as HTMLElement;
    copy.removeClass("tc-zoomable");
    copy.querySelectorAll(".tc-zoom-btn").forEach((b) => b.remove());
    stage.appendChild(copy);
    const toggle = () => stage.toggleClass("is-2x", !stage.classList.contains("is-2x"));
    stage.addEventListener("dblclick", toggle);
    const btn = this.contentEl.createEl("button", { cls: "tc-zoom-toggle", text: "Zoom 2×" });
    btn.onclick = toggle;
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** Puts a small zoom button on every image in `card` (and on the occlusion, if any). */
export function addZoomButtons(app: App, card: HTMLElement) {
  const targets: HTMLElement[] = [...card.querySelectorAll<HTMLElement>(".tc-occ")];
  for (const img of Array.from(card.querySelectorAll<HTMLImageElement>(".tc-side img"))) {
    if (img.closest(".tc-occ")) continue;
    const holder = img.closest<HTMLElement>(".internal-embed") ?? img;
    const wrap = createSpan({ cls: "tc-zoomable" });
    holder.replaceWith(wrap);
    wrap.appendChild(holder);
    targets.push(wrap);
  }
  for (const t of targets) {
    t.addClass("tc-zoomable");
    const b = t.createEl("button", { cls: "clickable-icon tc-zoom-btn", attr: { "aria-label": "Zoom image" } });
    setIcon(b, "maximize-2");
    // Pointer handlers on the card treat taps as reveal/swipe; keep this tap to ourselves.
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.onclick = (e) => {
      e.stopPropagation();
      new ZoomModal(app, t).open();
    };
  }
}

/** Draw, move, resize and label boxes over an image. Works with a mouse or a finger. */
export class OcclusionEditor extends Modal {
  private o: Occlusion;
  private stage!: HTMLElement;
  private img!: HTMLImageElement;
  private listEl!: HTMLElement;
  private selected: string | null = null;

  constructor(app: App, private sourcePath: string, start: Occlusion, private save: (o: Occlusion) => void | Promise<void>) {
    super(app);
    this.o = { ...start, boxes: start.boxes.map((b) => ({ ...b })) };
  }

  onOpen() {
    this.modalEl.addClass("tc-occ-editor-modal");
    this.titleEl.setText(`Image occlusion: ${this.o.image.split("/").pop()}`);
    const el = this.contentEl;
    el.createEl("p", { cls: "tc-muted", text: "Drag on the image to cover a part. Drag a box to move it, its corner to resize it. Each box becomes a card." });

    new Setting(el).setName("When asking").addDropdown((d) =>
      d
        .addOptions({ "hide-one": "Cover only the asked part", "hide-all": "Cover every part" })
        .setValue(this.o.mode)
        .onChange((v) => (this.o.mode = v === "hide-all" ? "hide-all" : "hide-one")),
    );
    new Setting(el).setName("Question").setDesc("Optional; shown and read aloud above the image.").addText((t) =>
      t.setPlaceholder("Name the covered structure").setValue(this.o.question).onChange((v) => (this.o.question = v)),
    );

    const file = imageFile(this.app, this.o.image, this.sourcePath);
    if (!file) {
      el.createEl("p", { text: `Image not found: ${this.o.image}` });
      return;
    }
    this.stage = el.createDiv({ cls: "tc-occ tc-occ-edit" });
    this.img = this.stage.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), draggable: "false" } });
    this.listEl = el.createDiv({ cls: "tc-occ-list" });
    this.attachDrawing();
    this.redraw();

    const row = el.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const ok = row.createEl("button", { cls: "mod-cta", text: "Save" });
    ok.onclick = async () => {
      if (!this.o.boxes.length) return new Notice("Draw at least one box first");
      await this.save(this.o);
      this.close();
    };
  }

  /** Image-relative 0–1 coordinates of a pointer event. */
  private at(e: PointerEvent) {
    const r = this.img.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  private attachDrawing() {
    let drag: { kind: "new" | "move" | "resize"; box: OcclusionBox; x0: number; y0: number; orig: OcclusionBox } | null = null;
    this.stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = this.at(e);
      const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-box]");
      let box: OcclusionBox;
      let kind: "new" | "move" | "resize";
      if (hit) {
        box = this.o.boxes.find((b) => b.id === hit.dataset.box)!;
        kind = (e.target as HTMLElement).classList.contains("tc-occ-handle") ? "resize" : "move";
      } else {
        box = { id: newBoxId(this.o.boxes.map((b) => b.id)), x: p.x, y: p.y, w: 0, h: 0, label: "" };
        this.o.boxes.push(box);
        kind = "new";
      }
      this.selected = box.id;
      drag = { kind, box, x0: p.x, y0: p.y, orig: { ...box } };
      try {
        this.stage.setPointerCapture(e.pointerId);
      } catch {
        // not an active pointer (synthetic event); dragging still works inside the image
      }
      e.preventDefault();
      this.redraw(false);
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const p = this.at(e);
      const { box, orig } = drag;
      if (drag.kind === "new") {
        box.x = Math.min(drag.x0, p.x);
        box.y = Math.min(drag.y0, p.y);
        box.w = Math.abs(p.x - drag.x0);
        box.h = Math.abs(p.y - drag.y0);
      } else if (drag.kind === "move") {
        box.x = Math.min(1 - orig.w, Math.max(0, orig.x + p.x - drag.x0));
        box.y = Math.min(1 - orig.h, Math.max(0, orig.y + p.y - drag.y0));
      } else {
        box.w = Math.max(0.01, Math.min(1 - orig.x, orig.w + p.x - drag.x0));
        box.h = Math.max(0.01, Math.min(1 - orig.y, orig.h + p.y - drag.y0));
      }
      this.redraw(false);
    });
    const end = () => {
      if (!drag) return;
      // A tap, not a drag: no box.
      if (drag.kind === "new" && (drag.box.w < 0.015 || drag.box.h < 0.015)) {
        this.o.boxes = this.o.boxes.filter((b) => b !== drag!.box);
        this.selected = null;
      }
      const isNew = drag.kind === "new";
      drag = null;
      this.redraw();
      if (isNew && this.selected) this.listEl.querySelector<HTMLInputElement>(`[data-label="${this.selected}"]`)?.focus();
    };
    this.stage.addEventListener("pointerup", end);
    this.stage.addEventListener("pointercancel", end);
  }

  /** Redraws the boxes; `list` also rebuilds the label list (not while dragging, to keep focus). */
  private redraw(list = true) {
    this.stage.querySelectorAll(".tc-occ-box").forEach((b) => b.remove());
    this.o.boxes.forEach((b, i) => {
      const el = this.stage.createDiv({ cls: `tc-occ-box is-outline${b.id === this.selected ? " is-selected" : ""}` });
      el.dataset.box = b.id;
      place(el, b);
      // Just the number here: names are in the list below, and would hide what's being covered.
      el.createSpan({ cls: "tc-occ-label", text: String(i + 1) });
      el.createDiv({ cls: "tc-occ-handle" });
    });
    if (!list) return;
    this.listEl.empty();
    this.o.boxes.forEach((b, i) => {
      const row = this.listEl.createDiv({ cls: `tc-occ-row${b.id === this.selected ? " is-selected" : ""}` });
      row.createSpan({ cls: "tc-occ-num", text: String(i + 1) });
      const input = row.createEl("input", { type: "text", placeholder: "Answer (what's under the box)", value: b.label });
      input.dataset.label = b.id;
      input.oninput = () => {
        b.label = input.value;
        this.redraw(false);
      };
      input.onfocus = () => {
        this.selected = b.id;
        this.redraw(false);
      };
      const del = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete box" } });
      setIcon(del, "trash-2");
      del.onclick = () => {
        this.o.boxes = this.o.boxes.filter((x) => x !== b);
        this.redraw();
      };
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Commands, the editor menu item, and the in-note preview of ```occlusion blocks. */
export function registerOcclusion(plugin: TalkingCards) {
  const app = plugin.app;

  const startOnLine = (editor: Editor, view: MarkdownView, checking: boolean): boolean => {
    const file = view.file;
    const line = editor.getCursor().line;
    const image = imagesOnLine(editor.getLine(line))[0];
    if (!file || !image) return false;
    if (checking) return true;
    new OcclusionEditor(app, file.path, { image, mode: "hide-one", question: "", boxes: [] }, (o) => {
      const end = { line, ch: editor.getLine(line).length };
      editor.replaceRange("\n" + formatOcclusionBlock(o), end);
    }).open();
    return true;
  };

  plugin.addCommand({
    id: "add-image-occlusion",
    name: "Add image occlusion to the image on this line",
    editorCheckCallback: (checking, editor, ctx) => (ctx instanceof MarkdownView ? startOnLine(editor, ctx, checking) : false),
  });

  plugin.registerEvent(
    app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info) => {
      if (!(info instanceof MarkdownView) || !startOnLine(editor, info, true)) return;
      menu.addItem((item) =>
        item
          .setTitle("Add image occlusion")
          .setIcon("square-dashed")
          .onClick(() => startOnLine(editor, info, false)),
      );
    }),
  );

  plugin.registerMarkdownCodeBlockProcessor("occlusion", (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const o = parseOcclusion(source);
    const box = el.createDiv({ cls: "tc-occ-block" });
    if (!o.image) {
      box.createDiv({ cls: "tc-muted", text: "Image occlusion: no image set." });
      return;
    }
    if (o.question) box.createDiv({ cls: "tc-occ-question", text: o.question });
    drawOcclusion(box, app, o, ctx.sourcePath, "overview");
    const bar = box.createDiv({ cls: "tc-occ-bar" });
    bar.createSpan({ cls: "tc-muted", text: `${o.boxes.length} card${o.boxes.length === 1 ? "" : "s"} · ${o.mode === "hide-all" ? "covers every part" : "covers the asked part"}` });
    const edit = bar.createEl("button", { text: "Edit boxes" });
    edit.onclick = () => {
      const info = ctx.getSectionInfo(el);
      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!info || !(file instanceof TFile)) return new Notice("Couldn't find this block in the note");
      new OcclusionEditor(app, ctx.sourcePath, o, async (next) => {
        await app.vault.process(file, (text) => {
          const lines = text.split("\n");
          lines.splice(info.lineStart, info.lineEnd - info.lineStart + 1, ...formatOcclusionBlock(next).split("\n"));
          return lines.join("\n");
        });
      }).open();
    };
  });
}
