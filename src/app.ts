import type { IncomingMessage, ServerResponse } from "node:http";

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
};

export const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (method === "GET" && (path === "/health" || path === "/health/liveness")) {
    json(response, 200, { status: "UP" });
    return;
  }

  if (method === "GET" && (path === "/rs/status" || path === "/api/status")) {
    json(response, 200, { ready: true, service: "dtsse-doc-render", engine: "stub" });
    return;
  }

  if (method === "GET" && (path === "/rs/ping" || path === "/api/ping")) {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("pong");
    return;
  }

  json(response, 404, { error: "Not found" });
};
