import { strFromU8, strToU8, type Zippable, zipSync } from "fflate";
import { LimitError } from "./errors.ts";
import { Scope } from "./expr.ts";
import { ImageMerger } from "./images.ts";
import { IncludeHost } from "./include.ts";
import { type Limits, resolveLimits } from "./limits.ts";
import { renderPart } from "./render.ts";
import { dropSvgAlternatives } from "./svg.ts";
import { type ArchiveTally, DocxFormatError, unzipWithin } from "./zip.ts";

export { DocxFormatError };

const CONTENT_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const ALREADY_COMPRESSED = /\.(png|jpe?g|gif|zip|docx|xlsx|pptx|mp3|mp4)$/i;

export interface RenderResult {
  output: Buffer;
  messages: string[];
}

export interface RenderOptions {
  devMode: boolean;
  now?: Date;
  limits?: Partial<Limits>;
  /** Templates a `ref:` or `refLookup:` may name, by name. */
  includes?: Record<string, Buffer>;
}

export function renderDocx(template: Buffer, data: unknown, options: RenderOptions): RenderResult {
  const limits = resolveLimits(options.limits);
  const tally: ArchiveTally = { entries: 0, total: 0 };
  const entries = unzipWithin(template, limits, tally);
  const host = new IncludeHost(entries, options.includes ?? {}, limits, tally);
  const images = new ImageMerger(entries, (path) => host.read(path));
  const names = Object.keys(entries);
  if (!names.includes("word/document.xml")) {
    throw new DocxFormatError("no word/document.xml, so this is not a .docx");
  }
  const scope = Scope.withNow(data, options.now ?? new Date());
  const messages: string[] = [];
  const parts = names.filter((n) => CONTENT_PART.test(n)).sort((a, b) => Number(b === "word/document.xml") - Number(a === "word/document.xml"));
  const rendered = new Map<string, Uint8Array>();
  const counter = { n: 0 };
  const budget = { limits, nodes: 0, bytes: 0 };
  try {
    for (const name of parts) {
      rendered.set(name, strToU8(renderPart(strFromU8(entries[name]!), name, scope, options.devMode, messages, counter, budget, host, images)));
    }
  } catch (e) {
    if (e instanceof LimitError) {
      throw e;
    }
    throw new DocxFormatError(`${e instanceof Error ? e.message : String(e)}`);
  }
  for (const [name, bytes] of host.finish()) {
    entries[name] = bytes;
  }
  images.finish();
  dropSvgAlternatives(entries, rendered);
  const mtime = options.now ?? new Date();
  const all = Object.keys(entries);
  const ordered = [...all.filter((n) => n === "[Content_Types].xml"), ...all.filter((n) => n !== "[Content_Types].xml")];
  const files: Zippable = {};
  for (const name of ordered) {
    const data = rendered.get(name) ?? entries[name]!;
    files[name] = [data, { level: ALREADY_COMPRESSED.test(name) ? 0 : 6, mtime }];
  }
  return { output: Buffer.from(zipSync(files)), messages: [...new Set(messages)] };
}
