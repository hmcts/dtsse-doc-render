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
| `POST /rs/render` (inline template) | As above, with `templateBase64` (JSON) or a multipart `templateFile` instead of `templateName`; see [Render a template in one request](#render-a-template-in-one-request) |
| `POST /rs/convert` | multipart `file`, `outputName`, `accessKey`; returns a PDF |
| `GET/POST /api/listTemplates` | `{"succeeded":true,"templateList":[{"name":...}]}` |
| `POST /api/uploadTemplate` | multipart `templateName` and `file` (or `templateFile`) |
| `/api/getTemplateStructure`, `/api/getSampleData` | 501 |

### Render a template in one request

`/rs/render` and `/api/render` also accept the template itself, so a tester needs no upload step. The template is used for that request only and is never written to the store. This is an extension of dtsse-doc-render, so use it only against this service.

- JSON: `templateBase64` holds the .docx bytes as base64. Standard and URL-safe alphabets both work, whitespace and newlines are ignored, and a `data:...;base64,` prefix is accepted.
- Multipart: a `templateFile` part carries the raw .docx bytes. `data` can be a plain field or a file part.
- When an inline template is given, `templateName` is optional and is used only as the name in error messages; it is never looked up in the store.
- Bytes that are not valid base64, or that do not start with the zip signature (`PK\x03\x04`), return 400.
- The access key goes in as `accessKey` where one is set (a body field, a form field or a query parameter), as for the other endpoints.
- Base64 makes the request about 33% larger than the .docx, and the 50 MB body limit applies to the whole request. Use the multipart form for templates over roughly 35 MB.

JSON:

```sh
curl -s localhost:8080/api/render -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$(base64 -w0 T.docx)" --slurpfile d payload.json '{templateBase64:$t, outputFormat:"pdf", data:$d[0]}')" -o out.pdf
```

macOS `base64` has no `-w0`; use `base64 -i T.docx` instead (it does not wrap lines). Add `accessKey:"..."` to the `jq` object where a key is set.

Multipart:

```sh
curl -s localhost:8080/api/render -F templateFile=@T.docx -F 'data=@payload.json;type=application/json' \
  -F outputFormat=pdf -o out.pdf
```

Add `-F accessKey=...` where a key is set.

Render failures return HTTP 400 as Docmosis does, with the first problem in `shortMsg` and every problem in `longMsg`.

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

`TEST_URL=http://localhost:8080 yarn test:smoke` and `yarn test:functional` run against any running instance. Set `TEST_ACCESS_KEY` when the target enforces one. The functional suite renders every fixture in `test/fixtures/src/<name>/` (a `document.xml`, `data.json` and the `expected.txt` merged text) as docx and PDF. After editing a fixture, run `node test/fixtures/build.mjs` to rebuild the committed `.docx` files.
