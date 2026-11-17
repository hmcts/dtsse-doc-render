export const baseUrl = (process.env.TEST_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const accessKey = process.env.TEST_ACCESS_KEY || undefined;

export interface RenderRequest {
  templateName: string;
  outputName?: string;
  outputFormat?: "pdf" | "docx";
  devMode?: boolean;
  data: unknown;
  accessKey?: string;
}

export async function status(): Promise<Response> {
  return fetch(`${baseUrl}/rs/status`);
}

export async function render(request: RenderRequest, path = "/api/render"): Promise<Response> {
  const { accessKey: keyOverride, ...rest } = request;
  const key = keyOverride ?? accessKey;
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outputName: `out.${request.outputFormat ?? "pdf"}`, ...rest, ...(key ? { accessKey: key } : {}) })
  });
}

export async function uploadTemplate(templateName: string, file: Buffer): Promise<Response> {
  const form = new FormData();
  form.set("templateName", templateName);
  if (accessKey) {
    form.set("accessKey", accessKey);
  }
  form.set("file", new Blob([new Uint8Array(file)]), templateName);
  return fetch(`${baseUrl}/api/uploadTemplate`, { method: "POST", body: form });
}

export async function convert(file: Buffer, outputName = "converted.pdf"): Promise<Response> {
  const form = new FormData();
  form.set("outputName", outputName);
  if (accessKey) {
    form.set("accessKey", accessKey);
  }
  form.set("file", new Blob([new Uint8Array(file)]), "input.docx");
  return fetch(`${baseUrl}/rs/convert`, { method: "POST", body: form });
}

export async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}
