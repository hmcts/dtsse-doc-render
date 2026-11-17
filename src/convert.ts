export type OutputFormat = "pdf" | "docx";

export async function convertToPdf(_document: Buffer, _sourceExtension: string): Promise<Buffer> {
  throw new Error("not implemented");
}
