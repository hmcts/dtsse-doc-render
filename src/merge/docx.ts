import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import { Scope } from "./expr.ts";
import { renderPart } from "./render.ts";

const CONTENT_PART = /^word\/(document|header\d*|footer\d*)\.xml$/;
const ALREADY_COMPRESSED = /\.(png|jpe?g|gif|zip|docx|xlsx|pptx|mp3|mp4)$/i;

export class DocxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxFormatError";
  }
}

export interface RenderResult {
  output: Buffer;
  messages: string[];
}

export function renderDocx(template: Buffer, data: unknown, options: { devMode: boolean; now?: Date }): RenderResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(template.buffer, template.byteOffset, template.byteLength));
  } catch (e) {
    throw new DocxFormatError(`not a readable zip archive: ${e instanceof Error ? e.message : String(e)}`);
  }
  const names = Object.keys(entries);
  if (!names.includes("word/document.xml")) {
    throw new DocxFormatError("no word/document.xml, so this is not a .docx");
  }
  const scope = new Scope(data);
  const messages: string[] = [];
  const parts = names.filter((n) => CONTENT_PART.test(n)).sort((a, b) => Number(b === "word/document.xml") - Number(a === "word/document.xml"));
  const rendered = new Map<string, Uint8Array>();
  try {
    for (const name of parts) {
      rendered.set(name, strToU8(renderPart(strFromU8(entries[name]!), name, scope, options.devMode, messages)));
    }
  } catch (e) {
    throw new DocxFormatError(`${e instanceof Error ? e.message : String(e)}`);
  }
  const mtime = options.now ?? new Date();
  const ordered = [...names.filter((n) => n === "[Content_Types].xml"), ...names.filter((n) => n !== "[Content_Types].xml")];
  const files: Zippable = {};
  for (const name of ordered) {
    const data = rendered.get(name) ?? entries[name]!;
    files[name] = [data, { level: ALREADY_COMPRESSED.test(name) ? 0 : 6, mtime }];
  }
  return { output: Buffer.from(zipSync(files)), messages: [...new Set(messages)] };
}
