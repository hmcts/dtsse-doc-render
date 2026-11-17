import { createServer } from "node:http";
import { createHandler } from "./app.ts";
import { converterReady, convertToPdf } from "./convert.ts";
import { mergeDocx } from "./merge/index.ts";
import { createStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8080);

const handler = createHandler({
  store: createStore({ templatesDir: process.env.TEMPLATES_DIR, uploadDir: process.env.UPLOAD_DIR, env: process.env.TEMPLATE_ENV || undefined }),
  merge: mergeDocx,
  convert: convertToPdf,
  accessKey: process.env.ACCESS_KEY || undefined,
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
