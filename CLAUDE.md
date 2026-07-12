# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (BullMQ + Redis) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Video Module (Phase 03)

Video upload, background processing, and delivery — implemented in `nestjs-project/src/videos/`, `storage/`, `queue/`, `core/`, and `worker/`.

- **Entity:** `Video` (`videos` table) — lifecycle `status`: `rascunho` → `processando` → `pronto`/`erro`. Fields include `storage_key`, `thumbnail_key`, `duration_seconds`, `metadata` (jsonb), `upload_id`, `error_message`.
- **Upload:** client-orchestrated presigned multipart upload (up to 10GB) — the API never receives the file bytes. `POST /videos` creates the draft and a multipart upload; `GET /videos/:id/upload-part-url` signs each part; `POST /videos/:id/complete-upload` finalizes the upload and enqueues processing.
- **Storage:** MinIO (S3-compatible), via `StorageService` (`src/storage/storage.service.ts`) using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`. Compose service `minio`.
- **Queue:** BullMQ + Redis, via `QueueModule` (`src/queue/queue.module.ts`). Queue `video-processing`, job `process-video`, `attempts: 3` with exponential backoff. Compose service `redis`.
- **Worker:** separate NestJS application context (no HTTP listener) — `src/worker/main.ts` + `WorkerModule`, sharing DB/config bootstrap with the API via `CoreModule` (`src/core/core.module.ts`) but never imported by `AppModule`, so it never competes with the API for the same queue. `VideoProcessor` (`src/videos/video.processor.ts`) reads the source video directly from a presigned GET URL (no full download) and uses `fluent-ffmpeg` to extract duration/metadata (`ffprobe`) and generate a thumbnail (`screenshots`). Run in dev with `npm run start:worker:dev` inside the `video-worker` container (idle by default, like `nestjs-api` — start explicitly, never automatically). Compose service `video-worker`.
- **Delivery:** `GET /videos/:id/stream` and `GET /videos/:id/download` are `@Public()` and anonymous — no ownership check, only `status: pronto` is required. Both return a presigned GET URL (download adds a `response-content-disposition=attachment` override); S3/MinIO natively serves `Range`/`206 Partial Content` on that URL, so the API never proxies video bytes.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.