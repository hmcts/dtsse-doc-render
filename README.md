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
| `POST /rs/render` | JSON, form or multipart `{templateBase64 or templateFile, includes?, outputName, outputFormat?, devMode?, data}`; returns the PDF or docx. `accessKey` is accepted and ignored |
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

### Send included templates with the request

A template that calls `<<ref:Other.docx>>` or `<<refLookup:field>>` merges another template in at that point. Docmosis finds it in its store; this service has none, so the request carries every template it may name, under the name the tag uses:

- JSON, or a form field: `includes` is an object of template name to base64 `.docx` (in a form field, the object as a JSON string).
- Multipart: any number of file parts named `include`; each is named by its filename.
- Both can be used in one request. At most 100 includes, each a zip. A name the tag asks for that was not sent fails as Docmosis's missing template does: `Template Not found [name]`, in devMode written into the document in place of the tag. Includes count against the same zip size limits as the template.

```sh
curl -s localhost:8080/api/render -F templateFile=@Letter.docx -F include=@Letter-Header.docx -F include=@Appeal-Heading.docx \
  -F 'data=@payload.json;type=application/json' -F outputFormat=pdf -o out.pdf
```

`docs/template-language.md` says what an include keeps of the template it comes from, and what it cannot carry.

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

The fixtures are real Docmosis templates, and their expected output is captured from a licensed Docmosis, not written by hand. A fixture is a directory `test/fixtures/src/<name>/` holding `document.xml` and `data.json` (and `header1.xml` if it has a header, and `styles.xml`, `numbering.xml`, `media/` and `rels.xml` (extra relationships) if it needs them).
- A fixture whose template calls `ref:` or `refLookup:` keeps the templates it includes in `includes/<name>.docx/`, one directory per template laid out the same way. `build.mjs` writes them to `test/fixtures/<fixture>.includes/<name>.docx`, the functional suite and `compare.mjs` send them, and `capture.mjs` copies them into Docmosis's store under that name, so give an include a name no other fixture uses.
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
