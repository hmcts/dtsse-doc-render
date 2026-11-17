import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ConvertTarget } from "./convert.ts";
import { startTelemetry } from "./telemetry.ts";

// Application Insights has to start before anything else loads, or it disables the loggers created ahead of it.
const telemetry = await startTelemetry(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);

const { createHandler } = await import("./app.ts");
const { converterReady, convertTo, convertToPdf } = await import("./convert.ts");
const { mergeDocx } = await import("./merge/index.ts");

const port = Number(process.env.PORT ?? 8080);

const handler = createHandler({
  merge: mergeDocx,
  convert: convertToPdf,
  convertTo: (document, sourceExtension, targetFormat) => convertTo(document, sourceExtension, targetFormat as ConvertTarget),
  ready: converterReady,
  openapi: readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"),
  telemetry
});

const server = createServer((request, response) => {
  void handler(request, response);
});

server.listen(port, () => {
  console.log(`dtsse-doc-render listening on ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
