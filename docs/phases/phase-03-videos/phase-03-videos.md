---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-12T11:47:17"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-12T11:40:44"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-12T11:35:42"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload (up to 10GB, via API-orchestrated presigned multipart upload direct to MinIO/S3), automatic background processing (duration/metadata extraction + thumbnail generation via a dedicated FFmpeg worker consuming a BullMQ/Redis queue), collision-free unique video URLs (reusing the video's UUID), and playback/download via presigned GET URLs that leverage MinIO/S3's native Range/206 support — all backend-only, with the video's processing lifecycle (rascunho → processando → pronto/erro) reflected in the database.

---

## Step Implementations

<!-- SIs will be written in Phase B -->

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`uuid_generate_v4()`); also serves as the video's unique URL identifier *(per phase-03-videos/TD-04)* |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null *(per phase-03-videos/TD-03 — required at draft creation)* |
| status | enum(`rascunho`, `processando`, `pronto`, `erro`) | not null, default `rascunho` *(per phase-03-videos/TD-07)* |
| storage_key | varchar | not null — object key of the original video file, e.g. `videos/{id}/original.<ext>` *(per phase-03-videos/TD-02)* |
| thumbnail_key | varchar | nullable — set once the worker generates the thumbnail *(per phase-03-videos/TD-02, TD-05)* |
| duration_seconds | float | nullable — set from `ffprobe` output after processing *(per phase-03-videos/TD-05)* |
| metadata | jsonb | nullable — raw `ffprobe` stream/format data (width, height, codec, bitrate) *(per phase-03-videos/TD-05)* |
| upload_id | varchar | nullable — storage multipart `UploadId`, cleared once the upload completes *(per phase-03-videos/TD-03)* |
| error_message | text | nullable — last failure reason, set only when `status = erro` *(per phase-03-videos/TD-07)* |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel`.
**Indexes:** index on `channel_id` (FK lookup / owner's video listing).

### API Contracts

#### POST /videos (SI-03.X)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required *(per phase-03-videos/TD-03 — required at draft creation)*
- fileSize: number, required — total size in bytes, used to compute the multipart part count

**Response 201:**
- id: string (uuid)
- uploadId: string — storage multipart upload id
- partSize: number — fixed part size in bytes the client must use when splitting the file

**Error responses:**
- 400 validation error: when `title` or `fileSize` fail schema validation
- 400 FILE_TOO_LARGE: when `fileSize` exceeds the 10GB limit

---

#### GET /videos/:id/upload-part-url (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}

**Request query parameters:**
- partNumber: number, required — 1-indexed part number

**Response 200:**
- url: string — presigned `UploadPart` URL, expires in 1 hour *(per phase-03-videos/TD-03)*

**Error responses:**
- 403 VIDEO_NOT_OWNED: when the requester is not the video's channel owner
- 404 VIDEO_NOT_FOUND: when `id` does not match any video
- 409 UPLOAD_ALREADY_COMPLETED: when the video's upload has already been completed
- 400 validation error: when `partNumber` is missing or not a positive integer

---

#### POST /videos/:id/complete-upload (SI-03.X)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ partNumber: number, eTag: string }`, required — one entry per uploaded part, in order

**Response 200:**
- id: string (uuid)
- status: string — `processando` (the processing job has been enqueued) *(per phase-03-videos/TD-01, TD-07)*

**Error responses:**
- 403 VIDEO_NOT_OWNED: when the requester is not the video's channel owner
- 404 VIDEO_NOT_FOUND: when `id` does not match any video
- 409 UPLOAD_ALREADY_COMPLETED: when the video's upload has already been completed
- 400 INVALID_UPLOAD_PART: when a part's `eTag` does not match what the storage recorded
- 502 MULTIPART_UPLOAD_FAILED: when the storage backend fails to complete the multipart upload

---

#### GET /videos/:id (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- title: string
- status: string — `rascunho` \| `processando` \| `pronto` \| `erro`
- durationSeconds: number \| null
- errorMessage: string \| null

**Error responses:**
- 403 VIDEO_NOT_OWNED: when the requester is not the video's channel owner
- 404 VIDEO_NOT_FOUND: when `id` does not match any video

---

#### GET /videos/:id/stream (SI-03.X)

**Response 200:**
- url: string — presigned GET URL, expires in 1 hour; MinIO/S3 natively serves `Range` requests / `206 Partial Content` on this URL *(per phase-03-videos/TD-06)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match any video
- 409 VIDEO_NOT_READY: when the video's `status` is not `pronto`

---

#### GET /videos/:id/download (SI-03.X)

**Response 200:**
- url: string — presigned GET URL with `response-content-disposition=attachment`, expires in 1 hour *(per phase-03-videos/TD-06)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `id` does not match any video
- 409 VIDEO_NOT_READY: when the video's `status` is not `pronto`

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ (creates own) |
| GET /videos/:id/upload-part-url | ✗ | ✓ | ✓ |
| POST /videos/:id/complete-upload | ✗ | ✓ | ✓ |
| GET /videos/:id | ✗ | ✓ | ✓ |
| GET /videos/:id/stream | ✓ *(per phase-03-videos/TD-06 — public for `status: pronto`)* | ✓ | ✓ |
| GET /videos/:id/download | ✓ *(per phase-03-videos/TD-06 — public for `status: pronto`)* | ✓ | ✓ |

_`GET /videos/:id/stream` and `GET /videos/:id/download` are decorated `@Public()` — the service layer still enforces `status: pronto` for any requester and full ownership bypass for the video's own owner regardless of status (an owner may fetch their own draft/processing/error video for debugging, non-owners cannot)._

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Any video endpoint referencing an `id` that doesn't exist |
| VIDEO_NOT_OWNED | 403 | Upload/status endpoints called by a user who isn't the video's channel owner |
| UPLOAD_ALREADY_COMPLETED | 409 | `upload-part-url` or `complete-upload` called after the upload already completed |
| VIDEO_NOT_READY | 409 | `stream` or `download` called on a video whose `status` isn't `pronto` |
| INVALID_UPLOAD_PART | 400 | `complete-upload` called with a part `eTag` that doesn't match storage's record |
| MULTIPART_UPLOAD_FAILED | 502 | Storage backend fails to complete the multipart upload |
| FILE_TOO_LARGE | 400 | `POST /videos` called with `fileSize` above the 10GB limit |

_Error response shape inherited from `phase-02-auth/TD-07` (Custom Domain Exception Filter — `{ statusCode, error, message }`); no new format introduced this phase._

### Events/Messages

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessor` (per `phase-03-videos/TD-05`)
**Trigger:** fires when `POST /videos/:id/complete-upload` successfully completes the storage multipart upload, moving `status` from `processando`'s pre-state to enqueuing the job
**Delivery semantics:** at-least-once, with automatic retry — `attempts: 3`, exponential backoff (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`); `status` flips to `erro` (with `error_message` set) only after retries are exhausted

---

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
