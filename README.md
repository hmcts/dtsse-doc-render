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

Every `/rs/*` endpoint is also served under `/api/*`. Errors are `{"succeeded":false,"shortMsg":...,"longMsg":...}`.

| Endpoint | Behaviour |
| --- | --- |
| `GET /health`, `GET /health/liveness` | `{"status":"UP"}` |
| `GET /rs/status` | `{"ready":<LibreOffice available>,...}` |
| `GET /rs/ping` | 200 |
| `POST /rs/render` | JSON, form or multipart `{accessKey, templateName, outputName, outputFormat?, devMode?, data}`; returns the PDF or docx |
| `POST /rs/convert` | multipart `file`, `outputName`, `accessKey`; returns a PDF |
| `GET/POST /api/listTemplates` | `{"succeeded":true,"templateList":[{"name":...}]}` |
| `POST /api/uploadTemplate` | multipart `templateName` and `file` (or `templateFile`) |
| `/api/getTemplateStructure`, `/api/getSampleData` | 501 |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMPLATES_DIR` | `/templates` | Searched recursively for `.docx` files |
| `TEMPLATE_ENV` | unset | With `Base/` and environment folders, `<ENV>/` overrides `Base/` |
| `UPLOAD_DIR` | `/tmp/templates` | Uploaded templates, which take precedence |
| `ACCESS_KEY` | unset | When set, every endpoint except health, ping and status requires a matching `accessKey` |
| `SOFFICE_BIN` | `soffice` | LibreOffice binary |
| `SOFFICE_PROFILE_DIR` | `<tmpdir>/lo-profile` | Parent of the per-conversion profile directories |
| `SOFFICE_POOL_SIZE` | 2 | Concurrent conversions |
| `SOFFICE_TIMEOUT_MS` | 60000 | Per-conversion timeout |

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

`TEST_URL=http://localhost:8080 yarn test:smoke` and `yarn test:functional` run against any running instance. Set `TEST_ACCESS_KEY` when the target enforces one.

The fixtures are real Docmosis templates, and their expected output is captured from a licensed Docmosis, not written by hand. A fixture is a directory `test/fixtures/src/<name>/` holding `document.xml` and `data.json` (and `header1.xml` if it has a header).
- A merge fixture has an `expected.txt`, the merged text. The functional suite renders it as docx and PDF.
- A fixture whose name starts with `_` is one Docmosis rejects. It has an `error-phrase.txt` (hand-written: the phrase a rejection message must contain), `expected-error.txt` (Docmosis's status and message) and `expected-devmode.txt` (the document with the errors written in place). The functional suite checks the status and the phrase, and that devMode writes `Docmosis<N>` markers.

After editing a fixture, run `node test/fixtures/build.mjs` to rebuild the committed `.docx` files, then `node test/parity/capture.mjs` against a licensed Docmosis to rewrite the expected files. Read the diff of every `expected.txt`: if the output is not what the fixture is meant to show, fix the fixture.

## Checking parity with Docmosis

`test/parity/` compares this service with a licensed Docmosis. It is for local use and is not part of CI.

1. Start a licensed Docmosis from the workspace: `docmosis local start`. It listens on `http://127.0.0.1:18087` in the container `docmosis-local`.
2. Start this service: `docker compose up --build`, which listens on `http://localhost:8080`.
3. Point the scripts at both. The Docmosis access key is read from the container's `DOCMOSIS_ACCESSKEY` unless `DOCMOSIS_ACCESS_KEY` is set.

```
export DOCMOSIS_URL=http://127.0.0.1:18087   # DOCMOSIS_CONTAINER=docmosis-local, DOCMOSIS_ACCESS_KEY optional
export DR_URL=http://localhost:8080          # DR_ACCESS_KEY if the service enforces one
node test/parity/compare.mjs                 # every fixture on both, diffs printed; or name fixtures
node test/parity/templates.mjs <hmcts/docmosis>/Templates/Base CV-UNS-DEC-ENG-01133 FL-PRL-APP-ENG-FL401-draft
node test/parity/capture.mjs                 # rewrite expected files from Docmosis
```

`compare.mjs` prints `same` or `DIFF` per fixture and exits 1 on any difference. `templates.mjs` generates sample data for real templates, renders each on both with devMode on and writes the data, both texts and a diff to a directory it prints. Docmosis caches templates by file mtime, so every upload uses a fresh name; the scripts do this themselves.
