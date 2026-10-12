# Browser Agent

Local MVP for a conversational browser operator.

The repository contains a Chrome MV3 extension and a small Node API. The extension observes the active page, sends a sanitized accessibility-oriented snapshot to the API, and executes only the versioned `BrowserAction` protocol. The API validates model output and applies the risk policy before an action can be sent back to the browser.

## Project status

Current target is **v0.1.0, local MVP**. The working features and gaps are tracked in [MILESTONES.md](./MILESTONES.md). This version is for local evaluation; it is not production-ready.

### Implemented in v0.1.0

- Chrome MV3 side panel with conversation input, Explore/Plan/Execute modes, task events, approval prompts, and pause/continue/stop controls.
- Page observation and fixed browser actions for navigation, clicking, typing, selecting, keyboard input, scrolling, waiting, and text extraction.
- Tasks can start from a Chrome new tab or another browser-owned page. `open_url` reuses the current tab by default; the agent opens a new tab only when the user asks for one. The destination site permission is requested before page access.
- DeepSeek OpenAI-compatible model gateway, strict action validation, risk checks, sensitive-field blocking, cross-origin navigation confirmation, and action limits.
- PDF, DOCX, XLSX, PPTX, CSV, TXT, and Markdown parsing through a size-limited Python service; parsed text is passed to the task as untrusted context.
- PostgreSQL schema and optional Docker services are provided as foundations. They are not required for the local MVP.

### Not implemented yet

- Website file-input upload is disabled. File parsing is supported; attaching a local file to a website must wait for a confirmation screen that names the file and exact destination origin.
- The API currently keeps tasks and events in memory. The PostgreSQL schema is not wired into the API; Temporal workflows, device authentication, server-side WebSocket streaming, S3 retention, and a task-history screen remain future work.

`pnpm install`, `pnpm build`, and `pnpm test` pass in the current workspace. The API and parser health endpoints, task creation, demo action, and file-parse HTTP path were smoke-tested. A live DeepSeek request and a Chrome end-to-end task still need verification.

## Quick start

The local MVP does **not** require PostgreSQL, Redis, MinIO, Docker, or a database migration. Tasks live in API memory and are cleared when the API restarts. A DeepSeek API key is required for real browser actions; without it, the API uses a demo mode that safely finishes without operating the page.

```powershell
corepack pnpm install
Copy-Item .env.example .env
# Set DEEPSEEK_API_KEY in .env for live model actions.
corepack pnpm build
corepack pnpm --filter @browser-agent/api dev
```

In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`. Keep the API terminal running while using the extension.

For file uploads, start the parser in a second terminal:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r apps/parser/requirements.txt
.\.venv\Scripts\python.exe -m uvicorn main:app --app-dir apps/parser --host 127.0.0.1 --port 8790
```

Set `DEEPSEEK_MODEL` in `.env` to choose a different compatible model. The parser service is only needed for file uploads. Redis at `127.0.0.1:6379` is not used by this MVP yet; `pnpm db:up` starts the optional Compose Redis and can conflict with an already-running local Redis.

## Safety boundary

Model output is untrusted data. It is parsed with the protocol validator, checked by the risk policy, and executed by a fixed browser action dispatcher. There is no `eval`, remote code loading, or model-generated JavaScript. Login, submit, send, purchase, delete, and file-upload actions pause for explicit confirmation.

The browser remains the source of truth for page state. The observation sent to the model includes the page origin rather than its full URL, avoiding query strings and fragments that may contain tokens. Page text can still contain personal information, so only use pages you intend to send to the configured model provider. If the extension disconnects or the page version changes, the action is rejected and the task is paused for a fresh observation.

## Layout

- `apps/extension`: Chrome side panel, service worker, and content script.
- `apps/api`: HTTP API and DeepSeek-compatible model gateway.
- `packages/protocol`: shared action types, validation, risk policy, and wire messages.
- `database/schema.sql`: PostgreSQL schema for users, tasks, runs, events, files, approvals, and audit records.
- `apps/parser`: isolated, size-limited Python worker for PDF, Office, CSV, TXT, and Markdown parsing.
- `docker-compose.yml`: local PostgreSQL, Redis, and MinIO services.

## Current implementation limits

This is an executable MVP foundation, not a production deployment. The API task store is currently in memory; Temporal, PostgreSQL-backed repositories, authenticated device pairing, server-side WebSocket streaming, and object-storage retention are represented in the architecture/schema but are not wired into the request path yet. Files can be parsed and used as task context, but automatic upload into a website file input is not enabled. File bytes are sent to the local parser worker and are not persisted by this MVP. Use only on a trusted local machine until authentication and durable storage are implemented.
