# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/11 completed

### SI-03.1 — Infra: MinIO, Redis e worker de vídeo no Compose
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - Verificado via `docker compose up -d --build`: minio, redis, video-worker sobem healthy.
  - Verificado carregamento do Joi schema (storage/queue) via script ad-hoc com `ts-node`, sem subir o servidor (convenção do projeto: só sobe infra, nunca o app, a menos que pedido explicitamente).

### SI-03.2 — Migration + entidade Video
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.3 — StorageService (cliente S3/MinIO)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.4 — QueueModule (BullMQ)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Endpoint POST /videos
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Endpoint GET /videos/:id/upload-part-url
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Endpoint POST /videos/:id/complete-upload
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Endpoint GET /videos/:id
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Worker de processamento de vídeo (FFmpeg)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.10 — Endpoint GET /videos/:id/stream
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.11 — Endpoint GET /videos/:id/download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
