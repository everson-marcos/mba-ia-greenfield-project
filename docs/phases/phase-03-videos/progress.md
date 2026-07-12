# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/11 completed

### SI-03.1 — Infra: MinIO, Redis e worker de vídeo no Compose
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - Verificado via `docker compose up -d --build`: minio, redis, video-worker sobem healthy.
  - Verificado carregamento do Joi schema (storage/queue) via script ad-hoc com `ts-node`, sem subir o servidor (convenção do projeto: só sobe infra, nunca o app, a menos que pedido explicitamente).

### SI-03.2 — Migration + entidade Video
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - Migration gerada via `npm run migration:generate` (não escrita à mão), revisada e aplicada com sucesso contra o banco real.
  - Adicionado o lado inverso `Channel.videos` (OneToMany) para manter a relação bidirecional, por convenção do projeto.
  - `cleanAllTables` (helper de teste compartilhado) atualizado para incluir `videos` antes de `channels` (ordem por causa da FK).

### SI-03.3 — StorageService (cliente S3/MinIO)
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Bucket de teste criado sob demanda no `beforeAll` (MinIO não cria bucket automaticamente).
  - Teste do multipart usa uma parte de 5MB (mínimo exigido pela API S3 para partes que não são a última).

### SI-03.4 — QueueModule (BullMQ)
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - Seguindo o precedente já existente em `channels.module.spec.ts` (que também conecta a infra real dentro de um `.spec.ts`), o teste de compilação do `QueueModule` conecta ao Redis real em vez de mockar — consistente com a política do projeto de não mockar o que roda de verdade no Compose.
  - Nomes de fila/job centralizados em `videos.constants.ts` para reuso pelas SIs 03.7 (produtor) e 03.9 (consumidor).

### SI-03.5 — Endpoint POST /videos
- **Status:** completed
- **Tests:** 8 passing (3 unit + 2 integration + 3 e2e via spec `nestjs-project/specs/videos.plan.md`)
- **Observations:**
  - Adicionar a relação `Channel.videos` (SI-03.2) quebrou 9 arquivos de teste pré-existentes que montavam `DataSource` de teste sem incluir a entidade `Video` na lista — corrigido em todos (adicionado `Video` a cada `ALL_ENTITIES`). Suíte completa reconfirmada verde (158 unit/integration) depois do reparo.
  - `ChannelsService` ganhou `findByUserId` + injeção de `Repository<Channel>` — isso mudou a assinatura do construtor, exigindo ajuste nos 8 call-sites que instanciavam o serviço diretamente em testes.
  - `npm run test:e2e` (script puro, sem flag) roda suítes e2e em paralelo e causa violações reais de FK entre suítes que compartilham o banco — reproduzido e confirmado; sempre usar `npm run test:e2e -- --runInBand` (a menção "(always with --runInBand)" no CLAUDE.md é uma instrução para o operador, não um comportamento embutido no script).
  - `storage_key` usa apenas `videos/{id}/original` (sem extensão de arquivo) — o DTO de criação não carrega nome/mime-type do arquivo original, e a extensão não é necessária para o funcionamento do storage.

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
