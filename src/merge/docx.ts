import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import { LimitError } from "./errors.ts";
import { Scope } from "./expr.ts";
import { ImageMerger } from "./images.ts";
import { type Limits, resolveLimits } from "./limits.ts";
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

const mib = (n: number): string => `${Math.round(n / (1024 * 1024))} MiB`;

/**
 * Inflates every entry, refusing an archive whose declared sizes break the limits. fflate inflates into a buffer of the
 * declared size and fails if the data is longer, so the declared sizes bound the real ones; an entry declaring no size
 * but carrying data would be inflated without a bound, so it is refused.
 */
function unzipWithin(template: Buffer, limits: Limits): Record<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  try {
    return unzipSync(new Uint8Array(template.buffer, template.byteOffset, template.byteLength), {
      filter: (file) => {
        if (++entries > limits.maxEntries) {
          throw new LimitError(`the archive has more than ${limits.maxEntries} entries`);
        }
        if (file.originalSize > limits.maxEntryBytes) {
          throw new LimitError(`${file.name} is larger than ${mib(limits.maxEntryBytes)} uncompressed`);
        }
        total += file.originalSize;
        if (total > limits.maxTotalBytes) {
          throw new LimitError(`the archive is larger than ${mib(limits.maxTotalBytes)} uncompressed`);
        }
        if (file.originalSize === 0 && file.compression !== 0 && file.size > 16) {
          throw new DocxFormatError(`${file.name} declares no uncompressed size but has data`);
        }
        return true;
      }
    });
  } catch (e) {
    if (e instanceof LimitError || e instanceof DocxFormatError) {
      throw e;
    }
    throw new DocxFormatError(`not a readable zip archive: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function renderDocx(template: Buffer, data: unknown, options: { devMode: boolean; now?: Date; limits?: Partial<Limits> }): RenderResult {
  const limits = resolveLimits(options.limits);
  const entries = unzipWithin(template, limits);
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
  const images = new ImageMerger(entries);
  try {
    for (const name of parts) {
      rendered.set(name, strToU8(renderPart(strFromU8(entries[name]!), name, scope, options.devMode, messages, counter, budget, images)));
    }
  } catch (e) {
    if (e instanceof LimitError) {
      throw e;
    }
    throw new DocxFormatError(`${e instanceof Error ? e.message : String(e)}`);
  }
  images.finish();
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
