import { createServer } from "node:http";
import { createHandler } from "./app.ts";
import { converterReady, convertToPdf } from "./convert.ts";
import { mergeDocx } from "./merge/index.ts";

const port = Number(process.env.PORT ?? 8080);

const handler = createHandler({
  merge: mergeDocx,
  convert: convertToPdf,
  ready: converterReady
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
