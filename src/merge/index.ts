import { DocxFormatError, renderDocx } from "./docx.ts";
import { LimitError, type LimitName } from "./errors.ts";
import type { Limits } from "./limits.ts";

export class MergeError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    readonly kind: "limit" | "format" | "merge" = "merge",
    readonly limit?: LimitName
  ) {
    super(message);
    this.name = "MergeError";
  }
}

export interface MergeOptions {
  devMode: boolean;
  now?: Date;
  limits?: Partial<Limits>;
  /** Templates a `ref:` or `refLookup:` may name, by name. */
  includes?: Record<string, Buffer>;
}

export async function mergeDocx(template: Buffer, data: unknown, options: MergeOptions): Promise<Buffer> {
  let result: ReturnType<typeof renderDocx>;
  try {
    result = renderDocx(template, data, options);
  } catch (e) {
    if (e instanceof LimitError) {
      throw new MergeError("Template exceeds the merge limits", [e.message], "limit", e.limit);
    }
    if (e instanceof DocxFormatError) {
      throw new MergeError("Template is not a valid .docx", [e.message], "format");
    }
    throw e;
  }
  if (!options.devMode && result.messages.length > 0) {
    throw new MergeError("Template merge failed", result.messages);
  }
  return result.output;
}
