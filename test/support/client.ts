export const baseUrl = (process.env.TEST_URL ?? "http://localhost:8080").replace(/\/$/, "");

export interface RenderRequest {
  /** The .docx bytes, sent inline as templateBase64. */
  template: Buffer;
  outputName?: string;
  outputFormat?: "pdf" | "docx";
  devMode?: boolean;
  data: unknown;
  /** Templates a ref: or refLookup: may name, by name. */
  includes?: Record<string, Buffer>;
}

export async function status(): Promise<Response> {
  return fetch(`${baseUrl}/rs/status`);
}

export async function render({ template, includes, ...rest }: RenderRequest, path = "/api/render"): Promise<Response> {
  const encoded = includes ? Object.fromEntries(Object.entries(includes).map(([name, content]) => [name, content.toString("base64")])) : undefined;
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputName: `out.${rest.outputFormat ?? "pdf"}`, ...rest, includes: encoded, templateBase64: template.toString("base64") })
  });
}

export async function convert(file: Buffer, outputName = "converted.pdf"): Promise<Response> {
  const form = new FormData();
  form.set("outputName", outputName);
  form.set("file", new Blob([new Uint8Array(file)]), "input.docx");
  return fetch(`${baseUrl}/rs/convert`, { method: "POST", body: form });
}

export async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}
