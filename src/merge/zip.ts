import { unzipSync } from "fflate";
import { LimitError } from "./errors.ts";
import type { Limits } from "./limits.ts";

export class DocxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocxFormatError";
  }
}

/** Entries and uncompressed bytes counted so far across every archive of one merge, the template and its includes. */
export interface ArchiveTally {
  entries: number;
  total: number;
}

const newTally = (): ArchiveTally => ({ entries: 0, total: 0 });

const mib = (n: number): string => `${Math.round(n / (1024 * 1024))} MiB`;

/**
 * Inflates every entry, refusing an archive whose declared sizes break the limits. fflate inflates into a buffer of the
 * declared size and fails if the data is longer, so the declared sizes bound the real ones; an entry declaring no size
 * but carrying data would be inflated without a bound, so it is refused. The limits apply to the tally, so an include
 * counts against the same budget as the template that calls it.
 */
export function unzipWithin(archive: Buffer, limits: Limits, tally: ArchiveTally = newTally()): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength), {
      filter: (file) => {
        if (++tally.entries > limits.maxEntries) {
          throw new LimitError(`the archive has more than ${limits.maxEntries} entries`);
        }
        if (file.originalSize > limits.maxEntryBytes) {
          throw new LimitError(`${file.name} is larger than ${mib(limits.maxEntryBytes)} uncompressed`);
        }
        tally.total += file.originalSize;
        if (tally.total > limits.maxTotalBytes) {
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
