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

## Run it locally

```
docker compose up --build
```

The service listens on http://localhost:8080. It has no `ACCESS_KEY`, so it accepts any key or none. Templates uploaded through `/api/uploadTemplate` are kept by the running container only.

### Point a service at it

| Service | Setting |
| --- | --- |
| civil, prl | `DOCMOSIS_TORNADO_URL=http://localhost:8080` and `DOCMOSIS_SERVICE_BASE_URL=http://localhost:8080` |
| ia | the `docmosis.endpoint` property, `http://localhost:8080` |

From inside another container use `http://host.docker.internal:8080`, or join the service to this compose network.

### Use a clone of hmcts/docmosis

Mount the clone's `Templates/` directory read-only and say which environment folder to use:

```
TEMPLATES_DIR=/path/to/docmosis/Templates TEMPLATE_ENV=AAT docker compose up --build
```

`TEMPLATES_DIR` defaults to `./templates` and `TEMPLATE_ENV` is optional. The directory is mounted at `/templates`.

## Remote tests

`TEST_URL=http://localhost:8080 yarn test:smoke` and `yarn test:functional` run against any running instance. Set `TEST_ACCESS_KEY` when the target enforces one. The functional suite renders every fixture in `test/fixtures/src/<name>/` (a `document.xml`, `data.json` and the `expected.txt` merged text) as docx and PDF. After editing a fixture, run `node test/fixtures/build.mjs` to rebuild the committed `.docx` files.
