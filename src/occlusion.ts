// Image occlusion: boxes drawn over an image, each one a card. Pure: no Obsidian imports.
//
// Stored in the note as a fenced block, so it stays plain text, syncs, and survives without
// the plugin (Obsidian shows it as a code block):
//
//   ```occlusion
//   image: heart.png
//   mode: hide-one
//   question: Name the hidden structure
//   k3d: 0.120 0.300 0.200 0.080 Left atrium
//   ```
//
// Box lines: `<id>: x y w h label`, as fractions of the image's width/height (0–1), so boxes
// stay put at any display size. The id is short and random; it keeps a box's history when
// other boxes are added, moved or removed.

export type OcclusionMode = "hide-one" | "hide-all";

export interface OcclusionBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface Occlusion {
  /** Link text as written: `heart.png`, `Images/heart.png` or `[[heart.png]]` (brackets stripped). */
  image: string;
  /** hide-one: only the asked box is covered. hide-all: every box is covered, the asked one highlighted. */
  mode: OcclusionMode;
  question: string;
  boxes: OcclusionBox[];
}

const BOX_RE = /^([a-z0-9]{2,8}):\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s+(.*))?$/;
const FIELD_RE = /^(image|mode|question):\s*(.*)$/;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function parseOcclusion(body: string): Occlusion {
  const o: Occlusion = { image: "", mode: "hide-one", question: "", boxes: [] };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const box = BOX_RE.exec(line);
    if (box) {
      const [x, y, w, h] = [box[2], box[3], box[4], box[5]].map(Number);
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
        o.boxes.push({ id: box[1], x: clamp(x), y: clamp(y), w: clamp(w), h: clamp(h), label: (box[6] ?? "").trim() });
      }
      continue;
    }
    const f = FIELD_RE.exec(line);
    if (!f) continue;
    const v = f[2].trim();
    if (f[1] === "image") o.image = v.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
    else if (f[1] === "mode") o.mode = v === "hide-all" ? "hide-all" : "hide-one";
    else o.question = v;
  }
  return o;
}

const num = (n: number) => n.toFixed(3);

/** The block body (without fences), in the order parseOcclusion reads it. */
export function formatOcclusion(o: Occlusion): string {
  const lines = [`image: ${o.image}`, `mode: ${o.mode}`];
  if (o.question.trim()) lines.push(`question: ${o.question.trim()}`);
  for (const b of o.boxes) lines.push(`${b.id}: ${num(b.x)} ${num(b.y)} ${num(b.w)} ${num(b.h)}${b.label.trim() ? ` ${b.label.trim()}` : ""}`);
  return lines.join("\n");
}

export function formatOcclusionBlock(o: Occlusion): string {
  return "```occlusion\n" + formatOcclusion(o) + "\n```";
}

/** A short id not used by any box yet. */
export function newBoxId(taken: Iterable<string>): string {
  const used = new Set(taken);
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let id = "";
    for (let i = 0; i < 3; i++) id += abc[Math.floor(Math.random() * abc.length)];
    if (!used.has(id) && !/^\d+$/.test(id)) return id;
  }
}

/** Image embeds on a line: `![[heart.png]]`, `![[heart.png|300]]`, `![alt](heart.png)`. */
export function imagesOnLine(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/!\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif))(?:[|#][^\]]*)?\]\]/gi)) out.push(m[1].trim());
  for (const m of line.matchAll(/!\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif))\)/gi)) out.push(decodeURIComponent(m[1]));
  return out;
}
