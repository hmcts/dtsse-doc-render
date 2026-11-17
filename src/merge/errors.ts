export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

/** A merge limit was exceeded; reported to the caller as a bad template, not a server fault. */
export type LimitName = "entries" | "entryBytes" | "totalBytes" | "outputNodes" | "outputBytes" | "repeatItems";

export class LimitError extends Error {
  constructor(
    message: string,
    readonly limit: LimitName
  ) {
    super(message);
    this.name = "LimitError";
  }
}
