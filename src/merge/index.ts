import { DocxFormatError, renderDocx } from "./docx.ts";

export class MergeError extends Error {
  constructor(
    message: string,
    readonly details: string[] = []
  ) {
    super(message);
    this.name = "MergeError";
  }
}

export interface MergeOptions {
  devMode: boolean;
  now?: Date;
}

export async function mergeDocx(template: Buffer, data: unknown, options: MergeOptions): Promise<Buffer> {
  let result: ReturnType<typeof renderDocx>;
  try {
    result = renderDocx(template, data, options);
  } catch (e) {
    if (e instanceof DocxFormatError) {
      throw new MergeError("Template is not a valid .docx", [e.message]);
    }
    throw e;
  }
  if (!options.devMode && result.messages.length > 0) {
    throw new MergeError("Template merge failed", result.messages);
  }
  return result.output;
}
