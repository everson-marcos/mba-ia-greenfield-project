---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-12T11:47:17"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-12T12:03:29"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-12T11:35:42"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload (up to 10GB, via API-orchestrated presigned multipart upload direct to MinIO/S3), automatic background processing (duration/metadata extraction + thumbnail generation via a dedicated FFmpeg worker consuming a BullMQ/Redis queue), collision-free unique video URLs (reusing the video's UUID), and playback/download via presigned GET URLs that leverage MinIO/S3's native Range/206 support — all backend-only, with the video's processing lifecycle (rascunho → processando → pronto/erro) reflected in the database.

---

## Step Implementations

### SI-03.1 — Infra: MinIO, Redis e worker de vídeo no Compose

**Description:** Sobe a infraestrutura nova exigida pela fase (storage, fila, worker) e a configuração namespaced correspondente, seguindo a convenção herdada de `registerAs`.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml` (imagem `minio/minio`, portas 9000/9001, volume, healthcheck) (per `phase-03-videos/TD-02`)
2. Adicionar serviço `redis` ao `compose.yaml` (imagem `redis:7-alpine`, healthcheck) (per `phase-03-videos/TD-01`)
3. Adicionar serviço `video-worker` ao `compose.yaml` — mesma imagem do `nestjs-api` mas com `apt install ffmpeg` na imagem e comando de entrypoint diferente (per `phase-03-videos/TD-05`)
4. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` via `registerAs` (per convenção herdada de `phase-01-configuracao-base/TD-03`) + entradas correspondentes no schema Joi de `env.validation.ts` (per `phase-01-configuracao-base/TD-02`)
5. Atualizar `.env.example` com `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `REDIS_HOST`, `REDIS_PORT`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis` e `video-worker` com status healthy
- `ConfigModule` carrega `storageConfig`/`queueConfig` sem erro de validação Joi

---

### SI-03.2 — Migration + entidade Video

**Description:** Cria a tabela `videos` e a entidade TypeORM correspondente, ligada ao canal do dono, conforme o Data Model desta fase.

**Technical actions:**

1. Gerar migration `CreateVideos` via TypeORM CLI (`npm run migration:generate`, per convenção do skill `typeorm`) criando a tabela `videos` com os campos de `## Technical Specifications → Data Model → Video`
2. Criar `src/videos/entities/video.entity.ts` com os campos, o enum de `status` e a relação `ManyToOne` com `Channel`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, enum `status`, FK `channel_id` | `video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A migration roda limpa contra um banco vazio e é revertível (`migration:revert`)
- A tabela `videos` tem todas as colunas do Data Model e uma FK para `channels(id)`
- Inserir um `Video` sem `channel_id` viola a constraint `not null`

---

### SI-03.3 — StorageService (cliente S3/MinIO)

**Description:** Encapsula o cliente AWS SDK v3 usado para orquestrar o multipart upload e gerar URLs pré-assinadas de GET, conforme `phase-03-videos/TD-02`.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage` (per `phase-03-videos/TD-02`; setup exato em `library-refs.md`)
2. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `getUploadPartUrl`, `completeMultipartUpload`, `getPresignedGetUrl` (aceitando `ResponseContentDisposition` opcional para o fluxo de download)
3. Criar `StorageModule` global, injetando `S3Client` configurado via `storageConfig` (`endpoint`, `forcePathStyle: true`, credenciais) (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: round-trip real contra o MinIO do Compose — upload, presigned GET, multipart completo (per `phase-03-videos/TD-08`) | `storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — precisa do serviço `minio` e de `storageConfig`

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` válido contra o MinIO real
- `getPresignedGetUrl` retorna uma URL que responde a uma requisição `Range` com `206 Partial Content`
- `completeMultipartUpload` com partes válidas resulta em um objeto acessível no bucket

---

### SI-03.4 — QueueModule (BullMQ)

**Description:** Registra a fila `video-processing` com política de retry/backoff, conforme `phase-03-videos/TD-01` e `phase-03-videos/TD-07`.

**Technical actions:**

1. Instalar `@nestjs/bullmq`, `bullmq` (per `phase-03-videos/TD-01`; setup exato em `library-refs.md`)
2. Registrar `BullModule.forRootAsync` (conexão via `queueConfig`, nunca `localhost` — nome do serviço `redis`) e `BullModule.registerQueueAsync('video-processing', { defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } })` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `queue.module.spec.ts` |

**Dependencies:** SI-03.1 — precisa do serviço `redis` e de `queueConfig`

**Acceptance criteria:**

- O módulo compila e resolve `Queue` via `@InjectQueue('video-processing')` sem erro de DI
- Um job enfileirado nessa fila carrega `attempts: 3` e `backoff` exponencial nas suas opções

---

### SI-03.5 — Endpoint POST /videos

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Authenticated + Owner (cria vídeo para o próprio canal do requisitante)

**Description:** Cria o rascunho do vídeo e inicia o multipart upload no storage, per `phase-03-videos/TD-03`.

**Technical actions:**

1. Criar `CreateVideoDto` (`title: string` obrigatório, `fileSize: number` obrigatório) com `class-validator` (per `phase-02-auth/TD-06`, convenção herdada)
2. Criar `VideosController` + `VideosService.create` — persiste o `Video` com `status: rascunho` e `channel_id` do requisitante, chama `StorageService.createMultipartUpload` e retorna `id` + `uploadId` + `partSize`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.create` | Unit: branch logic (mock `StorageService`) | `videos.service.spec.ts` |
| `VideosService.create` | Integration: DB contract | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` com `{ title, fileSize }` válidos retorna `201` com `{ id, uploadId, partSize }`
- `POST /videos` sem `title` retorna `400` com erro de validação
- `POST /videos` com `fileSize` acima de 10GB retorna `400 FILE_TOO_LARGE`
- O vídeo criado tem `status: rascunho` no banco

---

### SI-03.6 — Endpoint GET /videos/:id/upload-part-url

**Route:** GET /videos/:id/upload-part-url
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Authenticated + Owner

**Description:** Emite a URL pré-assinada de uma parte específica do multipart upload, per `phase-03-videos/TD-03`.

**Technical actions:**

1. Criar verificação de ownership (`channel.user_id === req.user.id`) reutilizável em `VideosService`
2. Criar `VideosController.getUploadPartUrl` — valida ownership e `status: rascunho`, chama `StorageService.getUploadPartUrl(uploadId, partNumber)`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getUploadPartUrl` | Unit: branch logic (ownership, status) | `videos.service.spec.ts` |
| `VideosService.getUploadPartUrl` | Integration: DB contract | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `GET /videos/:id/upload-part-url?partNumber=1` do dono retorna `200` com `{ url }`
- Chamado por um usuário que não é dono retorna `403 VIDEO_NOT_OWNED`
- Chamado para um `id` inexistente retorna `404 VIDEO_NOT_FOUND`
- Chamado após o upload já completado (`status` != `rascunho`) retorna `409 UPLOAD_ALREADY_COMPLETED`

---

### SI-03.7 — Endpoint POST /videos/:id/complete-upload

**Route:** POST /videos/:id/complete-upload
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Authenticated + Owner

**Description:** Finaliza o multipart upload no storage, muda o status para `processando` e enfileira o job de processamento, per `phase-03-videos/TD-03`, `phase-03-videos/TD-01`.

**Technical actions:**

1. Criar `CompleteUploadDto` (`parts: { partNumber: number, eTag: string }[]`) com `class-validator`
2. Criar `VideosController.completeUpload` — valida ownership e `status: rascunho`, chama `StorageService.completeMultipartUpload`, atualiza `Video.status` para `processando` e enfileira o job `process-video` com `{ videoId }` (per `phase-03-videos/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch logic (mock storage + queue) | `videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: DB contract + fila real (job enfileirado) | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` com partes válidas retorna `200` com `{ id, status: "processando" }`
- Um job `process-video` com `{ videoId: id }` fica na fila `video-processing` logo após a chamada
- Chamado com um `eTag` que não bate com o storage retorna `400 INVALID_UPLOAD_PART`
- Chamado por quem não é dono retorna `403 VIDEO_NOT_OWNED`
- Chamado após o upload já completado retorna `409 UPLOAD_ALREADY_COMPLETED`

---

### SI-03.8 — Endpoint GET /videos/:id

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Authenticated + Owner

**Description:** Expõe o status atual e metadados do vídeo para o dono acompanhar o ciclo `rascunho → processando → pronto/erro`, per `phase-03-videos/TD-07`.

**Technical actions:**

1. Criar `VideosController.findOne` + `VideosService.findOne` — valida ownership, retorna `{ id, title, status, durationSeconds, errorMessage }`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOne` | Integration: DB contract | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.5

**Acceptance criteria:**

- `GET /videos/:id` do dono retorna `200` com o status atual do vídeo
- Chamado por quem não é dono retorna `403 VIDEO_NOT_OWNED`
- Chamado para um `id` inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.9 — Worker de processamento de vídeo (FFmpeg)

**Description:** Container/entrypoint separado que consome a fila `video-processing`, extrai duração/metadados e gera o thumbnail via FFmpeg, per `phase-03-videos/TD-05`.

**Technical actions:**

1. Criar entrypoint separado `src/worker/main.ts` — bootstrap de um NestJS application context sem HTTP listener (per `phase-03-videos/TD-05`)
2. Instalar `fluent-ffmpeg`; garantir `ffmpeg`/`ffprobe` instalados na imagem do `video-worker` (per `phase-03-videos/TD-05`; setup em `library-refs.md`)
3. Criar `VideoProcessor` (`@Processor('video-processing') extends WorkerHost`) — roda `ffprobe` (duração + metadata) e `screenshots` (thumbnail no frame de 50%), faz upload do thumbnail via `StorageService`, atualiza o `Video` (`duration_seconds`, `metadata`, `thumbnail_key`, `status: pronto`)
4. Tratar o evento `'error'` do fluent-ffmpeg — deixar a exceção propagar para que o BullMQ registre a falha do job e acione o retry (per `phase-03-videos/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration: Redis + BullMQ + FFmpeg reais, com um vídeo-fixture pequeno, aguardando via `waitUntilFinished` (per `phase-03-videos/TD-08`) | `video.processor.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Um job com um vídeo-fixture válido processa e o `Video` correspondente termina com `status: pronto`, `duration_seconds` e `thumbnail_key` preenchidos
- Um job com um arquivo de vídeo corrompido esgota as 3 tentativas do BullMQ e o `Video` termina com `status: erro` e `error_message` preenchido

---

### SI-03.10 — Endpoint GET /videos/:id/stream

**Route:** GET /videos/:id/stream
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Anonymous (per `phase-03-videos/TD-06` — público para `status: pronto`)

**Description:** Emite a URL pré-assinada de GET usada para reprodução via streaming, sem exigir download completo, per `phase-03-videos/TD-06`.

**Technical actions:**

1. Decorar o endpoint com `@Public()` (per convenção herdada do guard JWT global, `phase-02-auth/TD-02`)
2. Criar `VideosController.stream` — valida `status: pronto` (dono pode acessar independente do status; não-dono só se `pronto`), chama `StorageService.getPresignedGetUrl`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: branch logic (status check) | `videos.service.spec.ts` |
| `VideosService.getStreamUrl` | Integration: DB contract | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `GET /videos/:id/stream` sem token, para um vídeo `pronto`, retorna `200` com `{ url }`
- A `url` retornada responde a uma requisição `Range` com `206 Partial Content`
- `GET /videos/:id/stream` para um vídeo que não está `pronto` (e o requisitante não é o dono) retorna `409 VIDEO_NOT_READY`
- Chamado para um `id` inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.11 — Endpoint GET /videos/:id/download

**Route:** GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Anonymous (per `phase-03-videos/TD-06` — público para `status: pronto`)

**Description:** Emite a URL pré-assinada de GET usada para download do arquivo original, per `phase-03-videos/TD-06`.

**Technical actions:**

1. Decorar o endpoint com `@Public()`
2. Criar `VideosController.download` — valida `status: pronto` (mesma regra de SI-03.10), chama `StorageService.getPresignedGetUrl` com `ResponseContentDisposition: 'attachment'`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: branch logic (status check) | `videos.service.spec.ts` |

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `GET /videos/:id/download` sem token, para um vídeo `pronto`, retorna `200` com `{ url }`
- A `url` retornada tem `response-content-disposition=attachment` como query parameter
- Chamado para um vídeo que não está `pronto` (e o requisitante não é o dono) retorna `409 VIDEO_NOT_READY`

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

```
SI-03.1 (no deps)
├── SI-03.3
└── SI-03.4

SI-03.2 (no deps)

SI-03.2 + SI-03.3
└── SI-03.5
    ├── SI-03.10
    └── SI-03.11

SI-03.2 + SI-03.5
└── SI-03.8

SI-03.3 + SI-03.5
└── SI-03.6

SI-03.3 + SI-03.4 + SI-03.5
└── SI-03.7

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.9
```

---

## Deliverables

- [ ] SI-03.1 — Infra: MinIO, Redis e worker de vídeo no Compose
- [ ] SI-03.2 — Migration + entidade Video
- [ ] SI-03.3 — StorageService (cliente S3/MinIO)
- [ ] SI-03.4 — QueueModule (BullMQ)
- [ ] SI-03.5 — Endpoint POST /videos
- [ ] SI-03.6 — Endpoint GET /videos/:id/upload-part-url
- [ ] SI-03.7 — Endpoint POST /videos/:id/complete-upload
- [ ] SI-03.8 — Endpoint GET /videos/:id
- [ ] SI-03.9 — Worker de processamento de vídeo (FFmpeg)
- [ ] SI-03.10 — Endpoint GET /videos/:id/stream
- [ ] SI-03.11 — Endpoint GET /videos/:id/download

**Full test suites:**

- [ ] Testes unitários + integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
