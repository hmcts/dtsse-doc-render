import { strFromU8, strToU8 } from "fflate";
import { evaluate, type Scope } from "./expr.ts";
import { childEls, decodeEntities, findDescendants, parseXml, type XEl } from "./xml.ts";

/** How a part reports a fault: in the body Docmosis numbers it, in a header or footer it gives the reason. */
export interface ImageCtx {
  devMode: boolean;
  messages: string[];
  body: boolean;
  counter: { n: number };
  part: string;
}

interface Picture {
  bytes: Uint8Array;
  ext: string;
  type: string;
  width: number;
  height: number;
}

type Files = Record<string, Uint8Array>;

const PLACEHOLDER = /^(img|imgfit)_(.+)$/;
const FIELD = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const DATA_PREFIX = "image:base64:";
const RELATIONSHIP = /<Relationship\b[^>]*>/g;
const IMAGE_FAULT = "Unable to get image properties for image  Suggestion 1:Check the image source ";
const EMU_PER_TWIP = 635;

const attr = (el: XEl, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(el.open);
  return m ? decodeEntities(m[1] ?? m[2]!) : undefined;
};

function setAttr(el: XEl, name: string, value: string): void {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  el.open = el.open.replace(re, `$1"${value}"`);
}

/** Docmosis writes a picture's size in twentieths of a point, so every extent is a multiple of 635 EMU. */
const quantise = (emu: number): number => Math.max(1, Math.round(emu / EMU_PER_TWIP)) * EMU_PER_TWIP;

/** The picture's format and pixel size from its header, or null when it is not an image Docmosis can read. */
export function readPicture(bytes: Uint8Array): Picture | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR") {
    return { bytes, ext: "png", type: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 10 && b.toString("latin1", 0, 4) === "GIF8") {
    return { bytes, ext: "gif", type: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length > 26 && b.toString("latin1", 0, 2) === "BM") {
    return { bytes, ext: "bmp", type: "image/bmp", width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      const marker = b[i] === 0xff ? b[i + 1]! : 0;
      if (marker === 0) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { bytes, ext: "jpeg", type: "image/jpeg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) ? 1 : 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Pictures a field supplies: `image:base64:` and the data. Anything else, or nothing, means the placeholder goes. */
function pictureFrom(value: unknown): Picture | null | "bad" {
  if (typeof value !== "string" || !value.startsWith(DATA_PREFIX)) {
    return null;
  }
  const bytes = Buffer.from(value.slice(DATA_PREFIX.length).replace(/\s+/g, ""), "base64");
  return readPicture(new Uint8Array(bytes)) ?? "bad";
}

interface Job {
  drawing: XEl;
  fit: boolean;
  field: string;
}

type Event = { t: "start"; id: string; name: string; para: XEl | null } | { t: "end"; id: string } | { t: "draw"; el: XEl; para: XEl | null };

function collect(el: XEl, para: XEl | null, out: Event[]): void {
  for (const c of el.children) {
    if (c.kind !== "el" || c.dead) {
      continue;
    }
    if (c.name === "w:bookmarkStart") {
      out.push({ t: "start", id: attr(c, "w:id") ?? "", name: attr(c, "w:name") ?? "", para });
    } else if (c.name === "w:bookmarkEnd") {
      out.push({ t: "end", id: attr(c, "w:id") ?? "" });
    } else if (c.name === "w:drawing") {
      out.push({ t: "draw", el: c, para });
      collect(c, para, out);
    } else {
      collect(c, c.name === "w:p" ? c : para, out);
    }
  }
}

/** The pictures a placeholder bookmark names: those inside it, or for an empty bookmark the picture just before it, or a floating one after it. */
function pictureFor(events: Event[], from: number): XEl[] {
  const start = events[from] as Extract<Event, { t: "start" }>;
  const to = events.findIndex((e, i) => i > from && e.t === "end" && e.id === start.id);
  const inside = events.slice(from + 1, to < 0 ? events.length : to).filter((e): e is Extract<Event, { t: "draw" }> => e.t === "draw");
  if (inside.length > 0 || to < 0) {
    return inside.map((e) => e.el);
  }
  const before = events
    .slice(0, from)
    .reverse()
    .find((e) => e.t === "draw");
  if (before?.t === "draw" && before.para === start.para) {
    return [before.el];
  }
  const after = events.slice(to + 1).find((e) => e.t === "draw");
  return after?.t === "draw" && after.para === start.para && childEls(after.el, "wp:anchor").length > 0 ? [after.el] : [];
}

const placeholderName = (drawing: XEl): string | undefined => {
  const prop = findDescendants(drawing, "wp:docPr")[0];
  return prop ? attr(prop, "name") : undefined;
};

function extentOf(drawing: XEl): { cx: number; cy: number } | null {
  const ext = findDescendants(drawing, "wp:extent")[0];
  const cx = Number(ext && attr(ext, "cx"));
  const cy = Number(ext && attr(ext, "cy"));
  return cx > 0 && cy > 0 ? { cx, cy } : null;
}

/** The run that holds the drawing, which goes with it when nothing else is in the run. */
function runOf(drawing: XEl): XEl | null {
  return drawing.parent?.name === "w:r" ? drawing.parent : null;
}

function drop(el: XEl): void {
  el.dead = true;
  const run = runOf(el);
  if (run && !run.children.some((c) => c.kind === "el" && !c.dead && c.name !== "w:rPr")) {
    run.dead = true;
  }
}

function referenced(el: XEl, into = new Set<string>()): Set<string> {
  for (const m of el.open.matchAll(/\sr:(?:embed|id|link|pict)\s*=\s*"([^"]*)"/g)) {
    into.add(m[1]!);
  }
  for (const c of el.children) {
    if (c.kind === "el" && !c.dead) {
      referenced(c, into);
    }
  }
  return into;
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

function resolveTarget(relsPath: string, target: string): string {
  const base = dirOf(relsPath).replace(/_rels\/$/, "");
  const parts = (target.startsWith("/") ? target.slice(1) : base + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      out.pop();
    } else if (p !== ".") {
      out.push(p);
    }
  }
  return out.join("/");
}

/**
 * Docmosis image fields: a picture inside a bookmark named `img_<field>` or `imgfit_<field>`, or a picture whose
 * `wp:docPr` name is one of those. The field's value `image:base64:<data>` replaces the picture, `img_` stretching the
 * new one to the placeholder's size and `imgfit_` fitting it inside that size at its own proportions. With no usable
 * value the picture is removed.
 */
export class ImageMerger {
  private readonly rels = new Map<string, string>();
  private readonly orphans = new Set<string>();
  private readonly types = new Map<string, string>();
  private added = 0;

  constructor(private readonly files: Files) {}

  apply(root: XEl, scope: Scope, ctx: ImageCtx): void {
    const events: Event[] = [];
    collect(root, null, events);
    const jobs = new Map<XEl, Job>();
    events.forEach((e, i) => {
      if (e.t === "start") {
        const m = PLACEHOLDER.exec(e.name);
        const found = m ? pictureFor(events, i) : [];
        if (m && found.length === 1 && FIELD.test(m[2]!)) {
          jobs.set(found[0]!, { drawing: found[0]!, fit: m[1] === "imgfit", field: m[2]! });
        }
      }
    });
    for (const e of events) {
      const m = e.t === "draw" ? PLACEHOLDER.exec(placeholderName(e.el) ?? "") : null;
      if (e.t === "draw" && m && FIELD.test(m[2]!) && !jobs.has(e.el)) {
        jobs.set(e.el, { drawing: e.el, fit: m[1] === "imgfit", field: m[2]! });
      }
    }
    if (jobs.size === 0) {
      return;
    }
    const gone = new Set<string>();
    for (const job of jobs.values()) {
      this.merge(job, scope, ctx, gone);
    }
    const still = referenced(root);
    for (const rid of gone) {
      if (!still.has(rid)) {
        this.release(ctx.part, rid);
      }
    }
  }

  private merge(job: Job, scope: Scope, ctx: ImageCtx, gone: Set<string>): void {
    const blip = findDescendants(job.drawing, "a:blip")[0];
    const old = blip && attr(blip, "r:embed");
    const picture = pictureFrom(evaluate(job.field, scope));
    if (old) {
      gone.add(old);
    }
    if (picture === "bad") {
      this.fault(job, ctx);
      return;
    }
    const box = extentOf(job.drawing);
    if (!picture || !blip || !box || picture.width === 0 || picture.height === 0) {
      drop(job.drawing);
      return;
    }
    const scale = job.fit ? Math.min(box.cx / picture.width, box.cy / picture.height) : 0;
    const cx = quantise(job.fit ? picture.width * scale : box.cx);
    const cy = quantise(job.fit ? picture.height * scale : box.cy);
    setAttr(findDescendants(job.drawing, "wp:extent")[0]!, "cx", String(cx));
    setAttr(findDescendants(job.drawing, "wp:extent")[0]!, "cy", String(cy));
    for (const ext of findDescendants(job.drawing, "pic:spPr").flatMap((sp) => findDescendants(sp, "a:ext"))) {
      if (attr(ext, "cx") !== undefined) {
        setAttr(ext, "cx", String(cx));
        setAttr(ext, "cy", String(cy));
      }
    }
    for (const crop of findDescendants(job.drawing, "a:srcRect")) {
      crop.dead = true;
    }
    setAttr(blip, "r:embed", this.attach(ctx.part, picture));
  }

  private fault(job: Job, ctx: ImageCtx): void {
    ctx.messages.push(`Field <<${job.field}>> ${IMAGE_FAULT}(${ctx.part})`);
    if (!ctx.devMode) {
      return;
    }
    const text = ctx.body ? `<<${job.field}>>Docmosis${++ctx.counter.n}` : `<<${job.field}>>${IMAGE_FAULT}`;
    const run = runOf(job.drawing);
    const note = parseXml(`<w:r><w:t xml:space="preserve">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r>`).children[0] as XEl;
    if (run?.parent) {
      note.parent = run.parent;
      run.parent.children.splice(run.parent.children.indexOf(run), 0, note);
    }
    drop(job.drawing);
  }

  private relsOf(part: string): { path: string; xml: string } {
    const path = `${dirOf(part)}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;
    let xml = this.rels.get(path);
    if (xml === undefined) {
      const raw = this.files[path];
      xml = raw
        ? strFromU8(raw)
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      this.rels.set(path, xml);
    }
    return { path, xml };
  }

  private attach(part: string, picture: Picture): string {
    let name: string;
    do {
      name = `word/media/dr-image${++this.added}.${picture.ext}`;
    } while (this.files[name]);
    this.files[name] = picture.bytes;
    this.types.set(picture.ext, picture.type);
    const { path, xml } = this.relsOf(part);
    const id = `rIdDr${this.added}`;
    const rel = `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${name.startsWith(dirOf(part)) ? name.slice(dirOf(part).length) : `/${name}`}"/>`;
    this.rels.set(path, xml.replace("</Relationships>", `${rel}</Relationships>`));
    return id;
  }

  private release(part: string, rid: string): void {
    const { path, xml } = this.relsOf(part);
    let target: string | undefined;
    const next = xml.replace(RELATIONSHIP, (tag) => {
      const id = /\sId\s*=\s*"([^"]*)"/.exec(tag)?.[1];
      if (id !== rid || /TargetMode\s*=\s*"External"/.test(tag)) {
        return tag;
      }
      target = /\sTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
      return "";
    });
    this.rels.set(path, next);
    if (target) {
      this.orphans.add(resolveTarget(path, target));
    }
  }

  /** Writes the relationships and content types back, and drops media nothing refers to any more. */
  finish(): void {
    for (const [path, xml] of this.rels) {
      this.files[path] = strToU8(xml);
    }
    for (const [path, raw] of Object.entries(this.files)) {
      if (this.orphans.size > 0 && path.endsWith(".rels")) {
        for (const tag of strFromU8(raw).match(RELATIONSHIP) ?? []) {
          const target = /\sTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
          if (target && !/TargetMode\s*=\s*"External"/.test(tag)) {
            this.orphans.delete(resolveTarget(path, target));
          }
        }
      }
    }
    for (const path of this.orphans) {
      delete this.files[path];
    }
    const types = this.files["[Content_Types].xml"];
    if (types && this.types.size > 0) {
      let xml = strFromU8(types);
      for (const [ext, type] of this.types) {
        if (!new RegExp(`<Default\\b[^>]*Extension\\s*=\\s*"${ext}"`, "i").test(xml)) {
          xml = xml.replace("</Types>", `<Default Extension="${ext}" ContentType="${type}"/></Types>`);
        }
      }
      this.files["[Content_Types].xml"] = strToU8(xml);
    }
  }
}
