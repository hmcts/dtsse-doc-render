export interface Limits {
  /** Entries in the template zip. */
  maxEntries: number;
  /** Uncompressed bytes of any one zip entry. */
  maxEntryBytes: number;
  /** Uncompressed bytes of all zip entries together. */
  maxTotalBytes: number;
  /** Elements and text nodes cloned by repeats, over the whole merge. */
  maxOutputNodes: number;
  /** Bytes of merged part XML, counting inserted values as they are produced. */
  maxOutputBytes: number;
  /** Items in one repeat block. */
  maxRepeatItems: number;
}

const MiB = 1024 * 1024;

const DEFAULTS: Limits = {
  maxEntries: 2000,
  maxEntryBytes: 64 * MiB,
  maxTotalBytes: 256 * MiB,
  maxOutputNodes: 2_000_000,
  maxOutputBytes: 128 * MiB,
  maxRepeatItems: 10_000
};

const ENV: Record<keyof Limits, string> = {
  maxEntries: "MERGE_MAX_ENTRIES",
  maxEntryBytes: "MERGE_MAX_ENTRY_BYTES",
  maxTotalBytes: "MERGE_MAX_TOTAL_BYTES",
  maxOutputNodes: "MERGE_MAX_OUTPUT_NODES",
  maxOutputBytes: "MERGE_MAX_OUTPUT_BYTES",
  maxRepeatItems: "MERGE_MAX_REPEAT_ITEMS"
};

/** Defaults, overridden by `MERGE_MAX_*` environment variables, overridden by `overrides`. */
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(ENV) as (keyof Limits)[]) {
    const fromEnv = Number(process.env[ENV[key]]);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
      limits[key] = fromEnv;
    }
  }
  return { ...limits, ...overrides };
}
