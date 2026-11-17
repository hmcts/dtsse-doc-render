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
| `GET /health/readiness` | 200 `{"status":"UP"}`, or 503 `{"status":"DOWN"}` when LibreOffice is unavailable |
| `GET /rs/status` | `{"ready":<LibreOffice available>,...}` |
| `GET /rs/ping` | 200 |
| `POST /rs/render` | JSON, form or multipart `{templateBase64 or templateFile, outputName, outputFormat?, devMode?, data}`; returns the PDF or docx. `accessKey` is accepted and ignored |
| `POST /rs/convert` | multipart `file`, `outputName`; returns a PDF |
| `/api/getTemplateStructure`, `/api/getSampleData` | 501 |

There is no access key and no template store. A render request with only `templateName` returns 400.

Output formats are `pdf` and `docx`. Docmosis also produces `doc`, `odt`, `html` and `txt`; a request for any of them here returns 400. When `outputFormat` differs from the `outputName` extension, the extension is appended to the download name, as Docmosis does. An `outputName` with no known extension and no `outputFormat` returns 400. When the conversion queue is full the service answers 503 with `Retry-After: 5`.

### Send the template with the request

`/rs/render` and `/api/render` take the template itself; nothing is stored. This is an extension of dtsse-doc-render, so use it only against this service.

- JSON: `templateBase64` holds the .docx bytes as base64. Standard and URL-safe alphabets both work, whitespace and newlines are ignored, and a `data:...;base64,` prefix is accepted.
- Multipart: a `templateFile` part carries the raw .docx bytes. `data` can be a plain field or a file part.
- `templateName` is optional and is used only as the name in error messages.
- Bytes that are not valid base64, or that do not start with the zip signature (`PK\x03\x04`), return 400.
- Base64 makes the request about 33% larger than the .docx, and the 50 MB body limit applies to the whole request. Use the multipart form for templates over roughly 35 MB. A field or file over the limit returns 413.

JSON:

```sh
curl -s localhost:8080/api/render -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$(base64 -w0 T.docx)" --slurpfile d payload.json '{templateBase64:$t, outputFormat:"pdf", data:$d[0]}')" -o out.pdf
```

macOS `base64` has no `-w0`; use `base64 -i T.docx` instead (it does not wrap lines).

Multipart:

```sh
curl -s localhost:8080/api/render -F templateFile=@T.docx -F 'data=@payload.json;type=application/json' \
  -F outputFormat=pdf -o out.pdf
```

Render failures return HTTP 400 as Docmosis does, with the first problem in `shortMsg` and every problem in `longMsg`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOFFICE_BIN` | `soffice` | LibreOffice binary |
| `SOFFICE_PROFILE_DIR` | `<tmpdir>/lo-profile` | Parent of the per-conversion profile directories |
| `SOFFICE_POOL_SIZE` | 2 | Concurrent conversions |
| `SOFFICE_TIMEOUT_MS` | 60000 | Per-conversion timeout |

## Run it locally

```
docker compose up --build
```

The service listens on http://localhost:8080.

### Point a service at it

| Service | Setting |
| --- | --- |
| civil, prl | `DOCMOSIS_TORNADO_URL=http://localhost:8080` and `DOCMOSIS_SERVICE_BASE_URL=http://localhost:8080` |
| ia | the `docmosis.endpoint` property, `http://localhost:8080` |

From inside another container use `http://host.docker.internal:8080`, or join the service to this compose network.

## Remote tests

`TEST_URL=http://localhost:8080 yarn test:smoke` and `yarn test:functional` run against any running instance.

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
export DR_URL=http://localhost:8080
node test/parity/compare.mjs                 # every fixture on both, diffs printed; or name fixtures
node test/parity/templates.mjs <hmcts/docmosis>/Templates/Base CV-UNS-DEC-ENG-01133 FL-PRL-APP-ENG-FL401-draft
node test/parity/capture.mjs                 # rewrite expected files from Docmosis
```

`compare.mjs` prints `same` or `DIFF` per fixture and exits 1 on any difference. `templates.mjs` generates sample data for real templates, renders each on both with devMode on and writes the data, both texts and a diff to a directory it prints. Docmosis caches templates by file mtime, so every template copied into it gets a fresh name; the scripts do this themselves. Templates are sent to this service inline.

### Visual parity

`test/parity/visual.mjs` measures how close this service's PDFs look to a licensed Docmosis's. It needs the same two backends as above, plus Docker for a throwaway image (`dtsse-doc-render-visual`, built once from `test/parity/visual/Dockerfile`: Alpine, poppler-utils and ImageMagick). Files go in and out with `docker cp`, so a remote Docker daemon works.

```
node test/parity/visual.mjs <hmcts/docmosis>/Templates/Base CV-PCS-CLM-ENG-Defence-Form --out /tmp/vis
node test/parity/visual.mjs <hmcts/docmosis>/Templates/Base --sample 120 --include names.txt --out /tmp/vis
node test/parity/fonts.mjs <hmcts/docmosis>/Templates/Base --out /tmp/fonts.json
```

For each template it generates data (the generator is shared with `templates.mjs` in `datagen.mjs`), renders a PDF on both with devMode on, rasterises every page at 100 dpi and writes `summary.json` and `report.html` to `--out`, with the PDFs and page images under `work/<template>/`. `--sample N` draws a sample proportional by jurisdiction prefix (`CV-`, `FL-`, `TB-`, ...) and always includes the names in the `--include` file. `--jobs` sets render concurrency (default 3), `--reuse` re-analyses PDFs already in `--out` without rendering, and `VISUAL_FUZZ` the anti-alias colour tolerance (default 12%). Per template the summary has:

- page counts on each side;
- per-page mismatch, the percentage of pixels that differ beyond the tolerance, and the same as a share of inked pixels;
- structural shift: text lines from `pdftotext -bbox-layout` matched by text, with the median and maximum horizontal and vertical offset in points, and how many lines moved to another page. A large shift with a low mismatch is content that moved; a high mismatch with no shift is a font or rendering difference;
- the fonts embedded in each PDF (`pdffonts`) and the image count.

`report.html` lists every template and shows the worst pages side by side with a diff image. A template that fails to render on either backend is listed under `failed` and not measured. `fonts.mjs` counts the font families the templates ask for (`fontTable.xml` and `w:rFonts`) and tabulates what `fc-match` picks in each container.
