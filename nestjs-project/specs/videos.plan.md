---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.10, SI-03.11
target_file: nestjs-project/test/videos.e2e-spec.ts
---

# Videos Endpoints Test Plan

## Application Overview

Endpoints do módulo de vídeos da Fase 03: criação do rascunho e orquestração do multipart upload (`POST /videos`, `GET /videos/:id/upload-part-url`, `POST /videos/:id/complete-upload`), consulta de status (`GET /videos/:id`), e entrega pública via URL pré-assinada para streaming e download (`GET /videos/:id/stream`, `GET /videos/:id/download`). Os três primeiros exigem autenticação e ownership do canal; os dois últimos são públicos para vídeos com `status: pronto`.

## Test Scenarios

### 1. POST /videos

**Setup:** truncar tabelas `videos`/`channels`/`users` no `beforeEach`; registrar+confirmar+logar um usuário real para obter um `access_token` válido (reusar o helper `registerConfirmAndLogin` já usado em `auth.e2e-spec.ts`).

#### 1.1. cria-video-com-payload-valido

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `POST /videos` com `Authorization: Bearer <access_token>` e body `{ title: "Meu vídeo", fileSize: 1048576 }`
    - expect: status `201`
    - expect: body contém `id` (uuid), `uploadId` (string), `partSize` (number)
  2. Consultar o vídeo criado diretamente no banco pelo `id` retornado
    - expect: `status` do registro é `"rascunho"`

---

#### 1.2. rejeita-titulo-ausente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `POST /videos` com `Authorization: Bearer <access_token>` e body `{ fileSize: 1048576 }` (sem `title`)
    - expect: status `400`
    - expect: body de erro de validação (formato `{ statusCode, error, message }` herdado da Fase 02)

---

#### 1.3. rejeita-arquivo-maior-que-10gb

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `POST /videos` com `Authorization: Bearer <access_token>` e body `{ title: "Vídeo enorme", fileSize: 10737418241 }` (10GB + 1 byte)
    - expect: status `400`
    - expect: `error: "FILE_TOO_LARGE"`

---

### 2. GET /videos/:id/upload-part-url

**Setup:** mesmo do Grupo 1, mais um vídeo `rascunho` pré-criado via `POST /videos` real no `beforeEach`.

#### 2.1. retorna-url-para-dono

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id/upload-part-url?partNumber=1` com `Authorization` do dono
    - expect: status `200`
    - expect: body contém `url` (string não vazia)

---

#### 2.2. rejeita-nao-dono

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. Registrar+confirmar+logar um segundo usuário
  2. `GET /videos/:id/upload-part-url?partNumber=1` com o `access_token` do segundo usuário, para o vídeo do primeiro
    - expect: status `403`
    - expect: `error: "VIDEO_NOT_OWNED"`

---

#### 2.3. retorna-404-para-video-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/00000000-0000-0000-0000-000000000000/upload-part-url?partNumber=1` com `Authorization` válido
    - expect: status `404`
    - expect: `error: "VIDEO_NOT_FOUND"`

---

#### 2.4. rejeita-upload-ja-completado

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. Completar o upload do vídeo pré-criado (via fluxo real de `complete-upload`, ou atualização direta de `status` para `processando` no banco de teste)
  2. `GET /videos/:id/upload-part-url?partNumber=1` com `Authorization` do dono
    - expect: status `409`
    - expect: `error: "UPLOAD_ALREADY_COMPLETED"`

---

### 3. POST /videos/:id/complete-upload

**Setup:** mesmo do Grupo 2; parte de upload real enviada ao MinIO de teste antes de cada cenário que precisa de um `eTag` válido.

#### 3.1. completa-upload-e-enfileira-job

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `POST /videos/:id/complete-upload` com `Authorization` do dono e body `{ parts: [{ partNumber: 1, eTag: "<etag-real-da-parte-enviada>" }] }`
    - expect: status `200`
    - expect: body `{ id, status: "processando" }`
  2. Consultar a fila `video-processing` real (via `getQueueToken`)
    - expect: existe um job `process-video` com `data.videoId` igual ao `id` do vídeo

---

#### 3.2. rejeita-etag-invalido

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `POST /videos/:id/complete-upload` com `Authorization` do dono e body `{ parts: [{ partNumber: 1, eTag: "etag-forjado-invalido" }] }`
    - expect: status `400`
    - expect: `error: "INVALID_UPLOAD_PART"`

---

#### 3.3. rejeita-nao-dono

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `POST /videos/:id/complete-upload` com `Authorization` de um usuário que não é dono
    - expect: status `403`
    - expect: `error: "VIDEO_NOT_OWNED"`

---

#### 3.4. rejeita-upload-ja-completado

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. Completar o upload uma vez (fluxo válido)
  2. Repetir `POST /videos/:id/complete-upload` com o mesmo `id`
    - expect: status `409`
    - expect: `error: "UPLOAD_ALREADY_COMPLETED"`

---

### 4. GET /videos/:id

**Setup:** mesmo do Grupo 1, mais um vídeo pré-criado.

#### 4.1. retorna-status-para-dono

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id` com `Authorization` do dono
    - expect: status `200`
    - expect: body `{ id, title, status, durationSeconds, errorMessage }` com `status` refletindo o valor atual no banco

---

#### 4.2. rejeita-nao-dono

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id` com `Authorization` de um usuário que não é dono
    - expect: status `403`
    - expect: `error: "VIDEO_NOT_OWNED"`

---

#### 4.3. retorna-404-para-video-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/00000000-0000-0000-0000-000000000000` com `Authorization` válido
    - expect: status `404`
    - expect: `error: "VIDEO_NOT_FOUND"`

---

### 5. GET /videos/:id/stream

**Setup:** mesmo do Grupo 1, mais um vídeo com `status: pronto` pré-inserido diretamente no banco de teste (processamento real fica coberto pela integração do worker, não por este E2E).

#### 5.1. retorna-url-publica-para-video-pronto

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id/stream` sem header `Authorization`, para um vídeo `pronto`
    - expect: status `200`
    - expect: body contém `url` (string não vazia)

---

#### 5.2. url-responde-range-com-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id/stream` sem `Authorization`, para um vídeo `pronto`, capturar a `url` retornada
  2. Fazer uma requisição HTTP direta à `url` com header `Range: bytes=0-99`
    - expect: status `206`
    - expect: header `Content-Range` presente na resposta

---

#### 5.3. rejeita-video-nao-pronto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id/stream` sem `Authorization`, para um vídeo com `status: processando`, por um requisitante que não é o dono
    - expect: status `409`
    - expect: `error: "VIDEO_NOT_READY"`

---

#### 5.4. retorna-404-para-video-inexistente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/00000000-0000-0000-0000-000000000000/stream` sem `Authorization`
    - expect: status `404`
    - expect: `error: "VIDEO_NOT_FOUND"`

---

### 6. GET /videos/:id/download

**Setup:** mesmo do Grupo 5.

#### 6.1. retorna-url-de-download-publica

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id/download` sem `Authorization`, para um vídeo `pronto`
    - expect: status `200`
    - expect: body contém `url` cuja query string inclui `response-content-disposition=attachment`

---

#### 6.2. rejeita-video-nao-pronto

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-12T15:13:00Z

**Steps:**
  1. `GET /videos/:id/download` sem `Authorization`, para um vídeo com `status: processando`, por um requisitante que não é o dono
    - expect: status `409`
    - expect: `error: "VIDEO_NOT_READY"`

---
