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

export async function mergeDocx(template: Buffer, _data: unknown, _options: MergeOptions): Promise<Buffer> {
  return template;
}
