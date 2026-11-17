import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHandler } from "./app.ts";
import { type ConvertTarget, converterReady, convertTo, convertToPdf } from "./convert.ts";
import { mergeDocx } from "./merge/index.ts";
import { startTelemetry } from "./telemetry.ts";

const SHUTDOWN_FLUSH_MS = 5000;

const telemetry = await startTelemetry(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);

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
  process.once(signal, () => {
    server.close(() => {
      void telemetry.flush(SHUTDOWN_FLUSH_MS).finally(() => process.exit(0));
    });
  });
}
