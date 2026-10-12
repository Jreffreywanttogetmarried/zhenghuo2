# Browser Agent milestones

Last updated: 2026-10-10 (Asia/Shanghai)

This document is the status source for implemented versions. “Done” means present in the repository; it does not imply that automated checks passed. Update this file whenever a feature moves between states or a release target changes.

## Version overview

| Version | Goal | Status |
|---|---|---|
| v0.1.0 | Local MVP: Chrome extension, page-control loop, DeepSeek adapter, risk gates, and file parsing | Build and unit tests pass; API/parser smoke checks pass; Chrome and live-model end-to-end checks pending |
| v0.2.0 | Durable and authenticated single-user beta | Planned |
| v1.0.0 | Production-ready personal browser agent | Planned |

## v0.1.0 — Local MVP foundation

### Done

- [x] Monorepo workspace with shared TypeScript protocol, Node API, Chrome MV3 extension, and Python parser service.
- [x] Side panel with task prompt, Explore/Plan/Execute mode selector, local file picker, task events, confirmation prompt, and pause/continue/stop controls.
- [x] Current-tab permission requested on demand; API binds to `127.0.0.1`; local Docker service ports bind to loopback and require operator-supplied credentials.
- [x] DOM-based page observation with accessible labels, element references, page-version invalidation, and basic email/card-number redaction.
- [x] Fixed action schema and runtime dispatcher for open URL, click, type, select, key, scroll, wait, extract, confirmation, and finish actions. Tasks may start from Chrome's new tab; URL navigation reuses the current tab by default and supports an explicit new-tab request.
- [x] DeepSeek-compatible structured-output gateway, demo mode without an API key, schema validation, action limits, and repeated-page loop detection. `.env` at the repository root is loaded by the API.
- [x] Risk gates for sensitive fields, risky controls, cross-origin navigation, and high-impact actions; user confirmation is required before those actions run.
- [x] File parsing for PDF, DOCX, XLSX, PPTX, CSV, TXT, and Markdown. The parser enforces size, archive-expansion, page/sheet, and output limits; parsed contents are marked untrusted and held in API memory for up to 30 minutes, then passed into the task context.
- [x] PostgreSQL schema draft with tenant-oriented tables, audit/event records, file metadata, and row-level security policies.
- [x] `pnpm install`, `pnpm build`, and `pnpm test` pass; 10 unit tests cover action policy, browser page context, model output validation, and in-memory task storage.
- [x] Local API/parser smoke checks pass for health, task creation, demo completion, and file parsing.

### Partial

- [ ] Cross-origin actions are gated in the API and the extension requests the new origin permission from the confirmation gesture. Recovery and navigation edge cases still need browser-level tests.
- [ ] File context passes through the extension/API code path, but a browser-to-live-model end-to-end test remains pending. Files are not retained in object storage and cannot yet be sent into a website file input.
- [ ] Pause/continue/stop work within the local in-memory task lifecycle; restart recovery and durable idempotency are not guaranteed.
- [ ] Docker Compose starts PostgreSQL, Redis, MinIO, and the parser, but only the parser is currently used by the API request path.

### Not started

- [ ] Website file upload with a confirmation view showing the exact filename and destination origin, followed by a one-action approval.
- [ ] Account login, device pairing, short-lived credentials, and authenticated browser/API communication.
- [ ] PostgreSQL-backed repositories, ownership checks, migration runner, and real tenant-scoped transactions.
- [ ] Temporal workflows, task resume after API restart, durable action idempotency, and server-side WebSocket event streaming.
- [ ] S3 upload/download, retention cleanup, malware scanning, user data deletion, and per-user audit history UI.
- [ ] Task history UI, screenshots, retry UX, production telemetry, rate limits, and a full Chrome extension end-to-end suite.

### Acceptance checks

- [x] `pnpm install` completes.
- [x] `pnpm build` completes for protocol, API, and extension.
- [x] `pnpm test` passes for all TypeScript packages.
- [x] Local Python parser starts and passes health and file-parse smoke checks. Docker container build remains unverified because Docker is not installed in this workspace.
- [ ] Unpacked extension installs in Chrome and completes a local test task from both a regular page and Chrome's new tab, including requested new-tab navigation.
- [ ] Sensitive typing, unsafe URLs, cross-origin navigation, high-impact clicks, user rejection, and repeated-action loops are blocked or paused as designed.
- [ ] Refreshing the page or restarting the extension does not cause duplicate side effects.

## v0.2.0 — Durable single-user beta

- [ ] Persist users, tasks, runs, messages, approvals, and append-only events in PostgreSQL; run tenant isolation checks.
- [ ] Add extension pairing and API authentication; keep the API bound privately and use TLS for remote deployment.
- [ ] Introduce Temporal workflows for long-running tasks, approvals, browser disconnects, and restart recovery.
- [ ] Add a task event stream and robust reconnect/replay semantics.
- [ ] Add S3-compatible storage, deletion/retention controls, and a secure file-upload approval flow naming both file and destination origin.
- [ ] Add Playwright tests for the extension and parser tests for supported file types and malformed inputs.

## v1.0.0 — Production-ready personal browser agent

- [ ] Operational monitoring, model-call accounting, rate limits, abuse controls, and incident-ready audit logs.
- [ ] Tested recovery and idempotency across browser, API, workflow-worker, and database restarts.
- [ ] Documented privacy, retention, and user deletion behavior; automated cleanup verified end to end.
- [ ] Chrome Web Store packaging, permission review, release checklist, and rollback procedure.

## Known constraints

CAPTCHA, MFA, browser-native dialogs, cross-origin frames, some Shadow DOM/Canvas apps, and website anti-automation controls require user takeover or may remain unsupported. The product must pause with a clear reason rather than claim success or loop indefinitely.
