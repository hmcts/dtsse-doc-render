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
