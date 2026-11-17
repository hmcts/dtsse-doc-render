# dtsse-doc-render

An unlicensed, API-compatible stand-in for Docmosis Tornado. It merges `<<...>>` Docmosis instructions in `.docx` templates and converts the result to PDF with headless LibreOffice. It is for local development and for the VPN-only AAT and preview deployments.

It is not Docmosis. A template that renders here has not been shown to work in Docmosis, so check anything that matters against the real service.

## Run

Requires Node 24 and Yarn 4.

```
yarn install
yarn build
yarn start        # listens on $PORT, default 8080
```

`yarn test`, `yarn test:coverage` and `yarn lint` run the unit tests and linter. `TEST_URL=http://localhost:8080 yarn test:smoke` checks a running instance.

## Endpoints

| Endpoint | Status |
| --- | --- |
| `GET /health`, `GET /health/liveness` | `{"status":"UP"}` |
| `GET /rs/status`, `GET /api/status` | `{"ready":true,...}` |
| `GET /rs/ping`, `GET /api/ping` | 200 |
| Render | coming |
| Convert | coming |
