---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-10
scope_description: "Backend foundation for video upload and processing: background queue technology, object storage usage (buckets/keys, presigned URLs), large-file upload strategy, video processing worker (ffmpeg/ffprobe), streaming/download delivery, unique video identifiers, and status-lifecycle/failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers all video capabilities: queue, object storage integration, upload orchestration, processing worker, streaming/download endpoints, and the videos table.
- `next-frontend/` — Frontend deferred: this phase is explicitly backend-only (`docs/project-plan.md` § Fase 03 lists no UI deliverable, and the video-viewing screen belongs to Fase 05). No open decision in this document.

> **Note on tooling:** `context7` MCP was not configured in this repository at the start of this research (`.mcp.json` only listed the `postgres` server). It was added and verified working mid-session before any library recommendation below was finalized — every library-specific claim (API shape, package name, options) was cross-checked against current Context7 documentation, not training data alone.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` leaves the queue technology as an open "TBD". Every video needs asynchronous post-upload processing (metadata + thumbnail extraction) without blocking the HTTP request/response cycle. The chosen technology must run entirely in the local Docker Compose stack (per `CLAUDE.md`'s Docker Networking rule) and integrate cleanly with NestJS 11 and the existing PostgreSQL-only infrastructure.

**Options:**

### Option A: BullMQ + Redis (via `@nestjs/bullmq`)
- Redis-backed job queue. `@nestjs/bullmq` provides `BullModule.forRootAsync()` for connection config and a `@Processor` + `WorkerHost` class pattern for consumers, plus `@OnWorkerEvent()` decorators for lifecycle hooks. Job-level `attempts`/`backoff` options are native BullMQ features.
- **Pros:** First-party-adjacent NestJS module (actively maintained under the `nestjs/bull` monorepo, distinct constants/metadata keys from legacy `@nestjs/bull` so it doesn't reuse deprecated Bull APIs). Built-in retry/backoff, delayed jobs, job progress, and dashboards (Bull Board) with zero custom code. Redis is a single, well-understood, lightweight container to add to `compose.yaml`. Large ecosystem and documentation (confirmed via Context7: 1000+ code snippets, high source reputation).
- **Cons:** Introduces a new infrastructure dependency (Redis) purely for the queue — no other part of the stack needs Redis yet. Requires a `redis` service + volume in `compose.yaml`.

### Option B: RabbitMQ (via `@nestjs/microservices` RMQ transport)
- Full AMQP broker. NestJS's built-in RMQ transport turns the API into a hybrid app that publishes messages; a separate microservice (the worker) consumes them.
- **Pros:** Industry-standard message broker, mature routing/exchange model, supports complex topologies (fan-out, dead-letter queues) natively.
- **Cons:** Heavier operationally (its own management UI, exchange/queue/binding concepts) for a single job type (video processing) with a single consumer. `@nestjs/microservices`' RMQ transport couples the queue choice to NestJS's hybrid-application model, a bigger structural change than adding a processor module. Overkill for the current scope — no fan-out/multi-consumer routing requirement exists in Phase 03.

### Option C: pg-boss (PostgreSQL-native queue)
- Job queue implemented entirely on top of PostgreSQL (`SKIP LOCKED`-based polling), no new infrastructure service — jobs live in a dedicated schema in the same `db` container already in Compose.
- **Pros:** Zero new infrastructure — reuses the existing PostgreSQL instance, matching the "tudo roda em Docker local" simplicity goal with one fewer moving part. No new networking/service to reason about.
- **Cons:** No official NestJS integration module (would require a hand-rolled wrapper service, more boilerplate than `@nestjs/bullmq`'s decorator-based processors). Polling-based dispatch is less immediate than Redis pub/sub-backed BullMQ. Smaller ecosystem/tooling (no equivalent to Bull Board for observability) and far less documentation depth (not found as a comparably documented library in Context7 during this research).

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — the retry/backoff semantics needed for TD-07 (failure handling) are native BullMQ features requiring zero custom code, the NestJS integration is decorator-based and idiomatic with the project's existing DI conventions, and Redis is a single, well-documented container — a modest addition to `compose.yaml` compared to RabbitMQ's operational surface. pg-boss avoids new infra but trades away NestJS-native ergonomics and mature tooling for a single-consumer, single-job-type workload where that trade isn't justified.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Libraries:** @nestjs/bullmq, bullmq

---

## TD-02: Object Storage Client and Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage backend itself is not open — the project already commits to an S3-compatible store (MinIO locally, replaceable by real AWS S3 in production, per the challenge brief). What remains open is **how** to talk to it (which client library) and **how** to organize buckets/keys for videos and thumbnails.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`)
- Official AWS SDK, S3-protocol native. `S3Client` accepts a custom `endpoint` + `forcePathStyle: true` to target MinIO instead of real AWS (confirmed via Context7 docs). `getSignedUrl()` from `s3-request-presigner` generates presigned PUT/GET URLs; `Upload` from `lib-storage` handles multipart upload orchestration (configurable `partSize`/`queueSize`) for large objects.
- **Pros:** True S3-protocol client — since the project explicitly plans to swap MinIO for real AWS S3 in production, this is a drop-in swap (only `endpoint`/credentials change, no code change). First-class multipart-upload helper (`lib-storage`) and presigned-URL helper (`s3-request-presigner`) cover every capability this phase needs out of the box. Huge documentation base (Context7: 24k+ code snippets, high reputation).
- **Cons:** Slightly more verbose client setup (three packages instead of one) compared to a MinIO-specific SDK.

### Option B: MinIO JavaScript Client (`minio` npm package)
- Native MinIO SDK with built-in `presignedPutObject()`/`presignedGetObject()` methods, tailored specifically to MinIO's API surface.
- **Pros:** Slightly simpler API for the MinIO-specific use case; single package.
- **Cons:** Ties application code to a MinIO-branded client. Since the project's own stated plan is to replace MinIO with real AWS S3 in production, standardizing on the MinIO-specific SDK now means a client-library migration later — the exact cost the "S3-compatible" positioning was meant to avoid.

**Bucket/key organization — evaluated alongside the client choice:**

### Option A: Single bucket, prefixed keys — `videos/{videoId}/original.<ext>`, `videos/{videoId}/thumbnail.jpg`
- **Pros:** One bucket to create/configure (lifecycle rules, CORS) at startup. Prefix-per-video keeps all assets for one video colocated, trivial to derive keys from the video's UUID (already the primary key per TD-04). Matches how S3-compatible tooling commonly organizes per-entity assets.
- **Cons:** A single bucket mixes original video files (large, cold after first view) and thumbnails (small, frequently read) — no bucket-level policy differentiation.

### Option B: Two buckets — `videos` and `thumbnails`
- **Pros:** Independent lifecycle/CORS/cache policies per asset type (e.g., aggressive CDN caching for thumbnails, different retention for originals).
- **Cons:** Two buckets to provision and keep in sync (bootstrap script/init container creates both). No Phase 03 requirement currently calls for differentiated policies — this is speculative flexibility.

**Recommendation:** **Client: Option A (AWS SDK v3)** — directly honors the project's own "MinIO now, S3 in production" plan with zero client-code migration cost, and `lib-storage`'s `Upload` class plus `s3-request-presigner` cover every storage need (presigned upload/download, multipart) documented for this phase. **Bucket organization: Option A (single bucket, prefixed keys)** — no differentiated-policy requirement exists yet in Phase 03; a second bucket can be introduced later without touching key-generation logic (keys are already namespaced by video ID).

**Decision:** A (AWS SDK v3, client) + A (single bucket, prefixed keys, organization)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

---

## TD-03: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file cannot be buffered through the NestJS API process without risking memory exhaustion and blocking the event loop/HTTP connection pool for the whole transfer duration — directly violating "sem travar o sistema". S3-compatible object storage has a **5GB hard limit on a single PUT operation**, so a naive "one presigned PUT URL" approach cannot even satisfy the 10GB requirement on its own; multipart upload is mandatory past that threshold, not just a nice-to-have. Depends on TD-01 (queue enqueues processing after upload completes) and TD-02 (storage client provides the multipart primitives).

**Options:**

### Option A: Single presigned PUT URL (client uploads directly to storage)
- API issues one presigned `PutObjectCommand` URL; the client does one HTTP PUT of the entire file directly to storage.
- **Pros:** Simplest possible handshake — one API call, one client upload call.
- **Cons:** **Does not satisfy the 10GB requirement** — S3-compatible single-PUT objects are capped at 5GB. No resumability: a dropped connection at byte 9.9GB means restarting the entire upload. Ruled out on functional grounds alone.

### Option B: Presigned multipart upload, orchestrated by the API
- API calls `CreateMultipartUpload`, returns the `uploadId` plus presigned `UploadPart` URLs (requested per-part or in a batch) to the client; the client PUTs each part directly to storage; a final API call triggers `CompleteMultipartUpload`. Bytes flow client → storage directly; the API only ever handles small JSON handshake payloads.
- **Pros:** The only option that actually supports files far beyond 10GB. Per-part failure is retryable without restarting the whole upload (resumability). The API process never touches file bytes — matches the architecture diagram (Frontend ↔ Object Storage direct streaming) and keeps API connections/memory footprint constant regardless of file size.
- **Cons:** More moving parts than Option A: the API must track the `uploadId` against the draft video row, and expose an extra "complete" endpoint.

### Option C: Streaming proxy through the API (e.g., `multer` streaming directly to storage, no disk buffering)
- Client uploads to a Nest endpoint; the API streams the incoming request body directly into an `Upload` (from `@aws-sdk/lib-storage`) without buffering the whole file in memory or on disk.
- **Pros:** Avoids the 5GB single-PUT limit (the SDK's `Upload` helper multiparts internally) and avoids full in-memory buffering.
- **Cons:** The HTTP connection to the API stays open for the entire transfer duration (potentially hours for 10GB on a slow connection), holding an API server connection/worker for the whole upload — exactly the "impacto na performance" the capability explicitly warns against. A single stalled client keeps an API-side resource occupied; Option B's client-to-storage transfers hold no API resource during the byte transfer itself.

**Recommendation:** **Option B (Presigned multipart upload, API-orchestrated)** — the only option that both satisfies the 10GB (and beyond) requirement and genuinely keeps the API out of the byte-transfer path. Flow: `POST /videos` creates the draft video row (`status: rascunho`) and a storage multipart upload, returning `videoId` + `uploadId` + presigned part URLs; the client PUTs parts directly to MinIO; `POST /videos/:id/complete-upload` completes the multipart upload and enqueues the processing job (TD-01), moving `status` to `processando`.

**Decision:** B (Presigned multipart upload, API-orchestrated)

**Note:** `title` is a **required** field on the `POST /videos` draft-creation payload (resolved 2026-07-12, ex-AMB-1) — the draft cannot be created without one. Fase 04 still owns subsequent title/description/category editing; this only fixes the initial value at upload start.

**Libraries:** —

---

## TD-04: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a URL that never collides with another video's. The project already generates collision-free UUIDs for every entity (`uuid_generate_v4()`, used by `users`, `channels`, `refresh_tokens`, `verification_tokens` per the Phase 01/02 migrations).

**Options:**

### Option A: Reuse the video's UUID primary key as the URL identifier
- The video route is `GET /videos/:id` where `:id` is the same UUID primary key generated by Postgres. No new column, no new uniqueness logic.
- **Pros:** Zero new code — uniqueness is already guaranteed by the existing `uuid_generate_v4()` primary-key pattern used project-wide. Nothing to test beyond what TypeORM/Postgres already guarantee.
- **Cons:** UUIDs are long (36 chars) and not human-memorable — a purely cosmetic downside, since Phase 03 has no "pretty/short URL" requirement.

### Option B: Short unique slug via `nanoid`, stored in a dedicated column
- A short (e.g. 10-char) URL-safe random slug generated at video creation, stored in a uniquely-constrained column, with retry-on-collision insert logic.
- **Pros:** Shorter, friendlier URLs.
- **Cons:** Needs an extra indexed column + collision-retry logic (however rare) that doesn't exist for any other entity in the codebase yet. No stated product requirement calls for short URLs in Phase 03 — this is speculative polish.

### Option C: Hash-derived slug (e.g. `hashids` over an auto-increment ID)
- Requires introducing a numeric sequential ID (the project uses UUIDs exclusively today — no entity has an auto-increment column) purely to feed the hash, plus a new dependency.
- **Pros:** Deterministic, short, reversible if ever needed.
- **Cons:** Forces a second identifier scheme (numeric + hash) onto an entity model that is UUID-only everywhere else in the codebase, for a cosmetic benefit not requested by any capability bullet.

**Recommendation:** **Option A (reuse the UUID primary key)** — the project's precedent for a *separate* public handle (the `Channel.nickname` column, distinct from `Channel.id`) exists specifically because channels need a memorable, user-chosen public identity. No such requirement exists for videos in this phase's capability list. Reusing the existing UUID costs nothing and defers a short-URL feature to a later phase if the product ever asks for one.

**Decision:** A (reuse the UUID primary key)

**Libraries:** —

---

## TD-05: Video Processing Worker Architecture

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) already names a dedicated "Video Worker (FFmpeg)" container that consumes queue jobs, distinct from the API container. This decision fixes how that worker is implemented and which FFmpeg wrapper it uses. Depends on TD-01 (the queue the worker consumes from).

**Options:**

### Option A: Separate NestJS entrypoint/container, `fluent-ffmpeg` wrapping system `ffmpeg`/`ffprobe`
- A second `main.ts`-style entrypoint (e.g. `src/worker/main.ts`) bootstraps a minimal Nest application context (no HTTP listener) that registers the BullMQ `@Processor`, reusing the same TypeORM entities, `ConfigModule`, and storage client already built for the API. Runs as its own `compose.yaml` service, sharing the codebase/image but with a different container command. Uses `fluent-ffmpeg`'s `ffprobe()` (duration + stream/format metadata as JSON) and `.screenshots()` (frame-based thumbnail extraction, confirmed via Context7: supports percentage-based timestamps like `'50%'` and custom output size).
- **Pros:** Matches the architecture diagram exactly (separate container). Keeps CPU-heavy transcoding/probing off the API process, so uploads and other endpoints stay responsive under processing load. Reuses every NestJS convention already established (DI, `registerAs` config, TypeORM entities) — no new patterns to learn. `fluent-ffmpeg` is a thin, well-documented wrapper (confirmed via Context7) over the two exact operations needed (`ffprobe`, `screenshots`).
- **Cons:** Requires the `ffmpeg`/`ffprobe` binaries to be present in the worker's image (not in `node:25.6.0-slim` by default) — needs an `apt install ffmpeg` layer or a dedicated Dockerfile for the worker service.

### Option B: In-process background job inside the same API process
- Same BullMQ processor pattern, but registered in the existing API app instead of a separate entrypoint/container.
- **Pros:** Fewer moving parts — one container, one `compose.yaml` service, one Dockerfile.
- **Cons:** Couples CPU-bound FFmpeg work with the process handling live HTTP traffic, directly contradicting both the architecture diagram (which models the worker as a separate container) and the same "não travar a API" principle already applied to uploads (TD-03) and streaming (TD-06) — a burst of video processing would compete with the API's event loop for the same resources.

### Option C: Plain Node.js script with a bare `bullmq` `Worker` (no NestJS)
- A standalone script, no Nest DI, manually wiring a database client and the queue connection.
- **Pros:** Minimal dependency footprint.
- **Cons:** Discards the TypeORM entities, `ConfigModule`/`registerAs` config pattern, and DI conventions already established across the codebase — every shared concern (DB connection, config, storage client) would need to be re-implemented or copy-pasted rather than reused.

**Recommendation:** **Option A (separate NestJS entrypoint/container using `fluent-ffmpeg`)** — the only option matching the architecture diagram's explicit separate Video Worker container while reusing 100% of the existing NestJS conventions (entities, config, storage client). `fluent-ffmpeg`'s `ffprobe()` and `screenshots()` cover the metadata-extraction and thumbnail-generation capabilities directly, confirmed against current documentation.

**Decision:** A (separate NestJS entrypoint/container using `fluent-ffmpeg`)

**Libraries:** fluent-ffmpeg

---

## TD-06: Video Delivery Strategy — Streaming and Download

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must support `Range` requests / `206 Partial Content` so a video starts playing without a full download; a separate capability lets the user explicitly download the file. Depends on TD-02 (storage client/keys).

**Options:**

### Option A: API proxies bytes, hand-rolled `Range`/`206` handling
- The Nest controller reads the object from storage as a stream and pipes it to the HTTP response, manually parsing the `Range` request header and emitting `Content-Range`/`Accept-Ranges`/`206` itself.
- **Pros:** Every byte passes through the API, so per-request authorization can be enforced with arbitrary granularity.
- **Cons:** Every playback second, for every viewer, flows through the API process — precisely the bottleneck the project is trying to avoid for large media files (the same concern already resolved for uploads via TD-03). Hand-rolled `Range` parsing is a well-known source of subtle bugs (off-by-one byte ranges, multi-range requests, seek behavior).

### Option B: Presigned GET URL (client fetches directly from storage)
- The API validates the request (video exists, is `pronto`, visibility rules), then returns a short-lived presigned GET URL; the browser's `<video>` element (or a download click) talks directly to MinIO/S3, which natively implements `Range`/`206` support.
- **Pros:** Bytes never pass through the API — matches the architecture diagram (Frontend ↔ Object Storage direct streaming) and mirrors the upload strategy's rationale (TD-03) for the download direction. S3-compatible storage already correctly implements `Range` handling; no custom code needed. The same mechanism serves both streaming (video element sets its own `Range` headers against the presigned URL) and download (a `response-content-disposition` override parameter, supported by presigned GET URLs, forces `Content-Disposition: attachment`).
- **Cons:** Authorization is checked once (when issuing the presigned URL), not per-byte-range — acceptable here since Phase 03 has no DRM/per-segment access requirement.

### Option C: Hybrid — proxy for streaming, presigned URL for download
- Different mechanisms for what is functionally the same GET operation on the same object.
- **Pros:** None beyond what B already provides.
- **Cons:** Doubles the implementation and testing surface (two delivery code paths) for no capability that actually needs the distinction.

**Recommendation:** **Option B (Presigned GET URL)** — reuses S3/MinIO's already-correct `Range`/`206` implementation instead of re-implementing it, keeps the API stateless and out of the bandwidth path for both streaming and downloading, and is symmetric with the upload decision (TD-03): the API only ever brokers short-lived signed URLs, never the bytes themselves.

**Decision:** B (Presigned GET URL)

**Note:** Streaming/download endpoints are **public** (`@Public()`, no JWT required) for videos with `status: pronto`, starting this phase (resolved 2026-07-12, ex-AMB-2) — ahead of Fase 05's "Acesso anônimo à visualização de vídeos" capability, to match the product's core anonymous-viewing vision and avoid reworking the auth boundary later.

**Libraries:** —

---

## TD-07: Video Processing Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video status column moves through `rascunho → processando → pronto/erro`. What remains open is what happens when the worker (TD-05) fails to process a video (corrupt file, transient storage error, FFmpeg crash) — whether that failure is retried automatically or surfaced immediately. Depends on TD-01 (the queue technology's retry primitives).

**Options:**

### Option A: BullMQ automatic retries (`attempts` + `backoff`), `erro` only after exhaustion
- The processing job is enqueued with e.g. `attempts: 3` and an exponential `backoff`, both native BullMQ job options. The video is only flipped to `status: erro` (with the last error message persisted) once BullMQ has exhausted all attempts; a transient failure resolves itself silently from the user's perspective.
- **Pros:** Zero custom retry code — `attempts`/`backoff` are standard BullMQ job options (confirmed via Context7 as part of `defaultJobOptions`/`QueueOptions`). Absorbs transient failures (brief storage unavailability, momentary resource contention) without user-visible impact.
- **Cons:** A permanently-broken input file (e.g. corrupted upload) still costs 2-3 wasted processing attempts before landing on `erro` — a small, bounded cost.

### Option B: Single attempt, immediate `erro`, manual reprocessing endpoint
- Any processing failure immediately sets `status: erro`; a separate endpoint lets the user (or an admin) manually re-trigger processing.
- **Pros:** Simplest possible worker logic — no retry configuration to reason about.
- **Cons:** Pushes recovery from *transient* failures onto the user having to notice the error and manually retry — worse UX for exactly the class of failure (momentary storage hiccup) that automatic retries handle for free.

### Option C: Custom retry loop inside the processor function
- Manual `try`/`catch` + requeue logic written by hand inside the `@Processor` method.
- **Pros:** Full control over retry semantics if BullMQ's model were somehow insufficient.
- **Cons:** Reimplements what `attempts`/`backoff` already provide out of the box, for no documented requirement that BullMQ's built-in model can't satisfy.

**Recommendation:** **Option A (BullMQ automatic retries, `erro` after exhaustion)** — a thin, standard use of the queue technology already chosen in TD-01, absorbing transient failures without any bespoke retry code, while still surfacing a genuine `erro` state (with the last failure reason) once retries are exhausted.

**Decision:** A (BullMQ automatic retries, `erro` after exhaustion)

**Libraries:** —

---

## TD-08: Testing Strategy for Queue and Worker Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Phase 02's integration tests all hit a real, synchronous PostgreSQL connection — there's no precedent yet in this codebase for testing an *asynchronous* background job that must complete before an assertion can run. `.claude/rules/nestjs-testing.md` establishes "use a real database... real modules" for integration tests, and the project's stated principle is "não mocke o que dá para rodar de verdade no Compose" — but neither addresses *how* a test should wait for real async job completion. This is the genuinely new decision Phase 03 introduces.

**Options:**

### Option A: Real Redis + real BullMQ queue, await completion via `QueueEvents.waitUntilFinished()`
- The integration/e2e test enqueues a job against the real queue (real Redis, real worker processor registered in the test module or running as a sibling process), then awaits `job.waitUntilFinished(queueEvents)` (a documented BullMQ mechanism, not a polling loop) with a bounded timeout, using a small fixture video so real FFmpeg/ffprobe processing stays fast.
- **Pros:** Exercises the real, deployed code path end-to-end — real queue wiring, real worker, real FFmpeg binary against a real (tiny) video file — catching integration bugs (serialization issues, wrong job options, FFmpeg command errors) that any mock would hide. Consistent with the project's established real-infrastructure testing convention.
- **Cons:** Test run time includes real FFmpeg processing (bounded to milliseconds/seconds for a tiny fixture video) and requires Redis to be up in the test environment (already true for `docker compose up` per TD-01).

### Option B: Mock the queue/worker boundary (stub `Queue.add()`, unit-test the processor directly)
- Integration tests stub the enqueue call; the processor function is unit-tested in isolation with a hand-constructed fake `Job` argument.
- **Pros:** Fast, fully deterministic, no Redis/FFmpeg dependency in that test run.
- **Cons:** Never exercises the real BullMQ wiring (job options, connection config) or the real FFmpeg binary — directly conflicts with the project's explicit "não mocke o que dá para rodar de verdade no Compose" rule, and is exactly the kind of gap that let the Fase 02 `migrations.integration-spec.ts` DB-state bug in this same repo go undetected until a second real run surfaced it.

### Option C: Fake in-memory queue that invokes the processor synchronously, no real Redis
- A stub `Queue` implementation calls the processor function directly in the same process/tick, bypassing Redis entirely.
- **Pros:** Avoids Redis as a test dependency.
- **Cons:** The retry/backoff behavior decided in TD-07 becomes untestable (there is no real queue to exhaust `attempts` against), and worker code must special-case whether it's talking to the real queue or the fake — the opposite of testing what actually ships.

**Recommendation:** **Option A (real Redis + BullMQ, `waitUntilFinished`)** — the only option consistent with this project's already-established, explicit preference for real infrastructure in integration tests, and the only one that actually exercises TD-07's retry/backoff behavior. `QueueEvents.waitUntilFinished()` is a clean, documented, non-polling primitive for this — not a fragile ad hoc polling loop.

**Decision:** A (real Redis + BullMQ, `waitUntilFinished`)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A: BullMQ + Redis |
| TD-02 | Backend | Object Storage Client & Bucket/Key Organization | AWS SDK v3 + single bucket, prefixed keys | A: AWS SDK v3 |
| TD-03 | Backend | Large File Upload Strategy (10GB) | Presigned multipart upload, API-orchestrated | B: Presigned multipart upload |
| TD-04 | Backend | Unique Video URL Identifier | Reuse UUID primary key | A: Reuse the video's UUID primary key as the URL identifier |
| TD-05 | Backend | Video Processing Worker Architecture | Separate NestJS container + `fluent-ffmpeg` | A: Separate NestJS entrypoint/container, |
| TD-06 | Backend | Video Delivery Strategy — Streaming and Download | Presigned GET URL | B: Presigned GET URL |
| TD-07 | Backend | Video Processing Status Lifecycle and Failure Handling | BullMQ automatic retries | A: BullMQ automatic retries |
| TD-08 | Backend | Testing Strategy for Queue and Worker Integration | Real Redis + BullMQ, `waitUntilFinished` | A: Real Redis + real BullMQ queue |
