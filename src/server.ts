import { createServer } from "node:http";
import { handleRequest } from "./app.ts";

const port = Number(process.env.PORT ?? 8080);

const server = createServer(handleRequest);

server.listen(port, () => {
  console.log(`dtsse-doc-render listening on ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
