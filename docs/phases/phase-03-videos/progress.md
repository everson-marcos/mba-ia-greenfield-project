# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

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
- **Status:** completed
- **Tests:** 12 passing (4 unit + 4 integration + 4 e2e, mesmo spec `videos.plan.md`)
- **Observations:**
  - Introduzida `findOwnedVideo` (helper privado em `VideosService`) reutilizável pelas próximas SIs de endpoint que exigem ownership.
  - Validação de `partNumber` via DTO (`UploadPartUrlQueryDto` com `class-transformer` + `class-validator`), consistente com a convenção do projeto de DTO+ValidationPipe em vez de pipes nativos do Nest.

### SI-03.7 — Endpoint POST /videos/:id/complete-upload
- **Status:** completed
- **Tests:** 31 passing (unit+integração 19 + queue.module.spec 1 + e2e 11)
- **Observations:**
  - Bug real pego pelo E2E: `@Post()` do Nest usa 201 por padrão; o contrato documentado (Tech Spec) exige 200 já que o endpoint transiciona estado de um recurso existente, não cria um novo. Corrigido com `@HttpCode(200)`.
  - `QueueModule` precisou reexportar o resultado exato de `BullModule.registerQueueAsync(...)` (guardado em variável, não `exports: [BullModule]` genérico) para que o provider da fila fique disponível via DI em `VideosModule`.
  - Classificação do erro do storage: `err.name === 'InvalidPart'` mapeia para `400 INVALID_UPLOAD_PART`; qualquer outro erro do storage vira `502 MULTIPART_UPLOAD_FAILED`.

### SI-03.8 — Endpoint GET /videos/:id
- **Status:** completed
- **Tests:** 39 passing
- **Observations:** none

### SI-03.9 — Worker de processamento de vídeo (FFmpeg)
- **Status:** completed
- **Tests:** 2 passing (integration, real Redis + BullMQ + FFmpeg + MinIO)
- **Observations:**
  - Extraído `CoreModule` (ConfigModule + TypeOrmModule.forRootAsync) para ser compartilhado entre `AppModule` e o novo `WorkerModule`, evitando duplicar o bootstrap entre os dois entrypoints (per `phase-03-videos/TD-05`).
  - `WorkerModule` é um NestJS application context separado (`src/worker/main.ts`, sem HTTP listener) que NÃO é importado por `AppModule` — evita que a API rode um segundo worker BullMQ concorrente consumindo a mesma fila.
  - `VideoProcessor` lê o vídeo direto da URL pré-assinada de GET (via `StorageService.getPresignedGetUrl`) para `ffprobe`/`screenshots`, em vez de baixar o arquivo inteiro para disco — evita materializar até 10GB no worker e aproveita o suporte a Range do S3/MinIO.
  - Bug real (mesma classe do já visto em SI-03.2): `WorkerModule` precisou registrar `Channel` e `User` em `TypeOrmModule.forFeature`, além de `Video` — sem eles, o TypeORM falha ao montar os metadados da relação `Video.channel` → `Channel.user` (erro "Entity metadata for X was not found"), já que o DataSource do worker é uma aplicação Nest separada da API e não herda registros de outros módulos.
  - Bug real pré-existente, exposto por este SI: `migrations.integration-spec.ts` faz `DROP TABLE "channels" ... CASCADE`, o que remove silenciosamente a FK `videos.channel_id → channels.id` sem apagar a tabela `videos` — linhas órfãs deixadas por qualquer suíte anterior quebravam o `synchronize: true` de qualquer outra suíte de integração que inclua `Video` (erro de violação de FK ao tentar recriar a constraint). Corrigido limpando `videos` no `beforeAll` desse teste.
  - Bug real pré-existente (regressão do fix anterior do enum): o `DROP TYPE IF EXISTS "verification_tokens_type_enum"` estava no mesmo `Promise.all` do `DROP TABLE "verification_tokens" CASCADE` — como ambos disparam concorrentemente sem ordem garantida, o DROP TYPE às vezes executa antes do DROP TABLE terminar, falhando com "other objects depend on it". Corrigido movendo o DROP TYPE para depois do `Promise.all` dos DROP TABLE.
  - `onFailed` (`@OnWorkerEvent('failed')`) só marca `status: erro` quando `job.attemptsMade >= job.opts.attempts` (última tentativa) — nas tentativas intermediárias o vídeo permanece `processando`, deixando o retry do BullMQ agir livremente (per `phase-03-videos/TD-07`).

### SI-03.10 — Endpoint GET /videos/:id/stream
- **Status:** completed
- **Tests:** 10 passing (3 unit + 3 integration + 4 e2e via spec `videos.plan.md`)
- **Observations:**
  - Ambiguidade real encontrada e resolvida com o usuário: o texto da Authorization Matrix ("dono pode acessar independente do status") exigiria um mecanismo de auth opcional que nenhuma TD especifica e nenhum AC testa — decidido (AskUserQuestion) implementar só o que os ACs cobrem: checagem 100% anônima de `status: pronto`, sem tentar identificar o requisitante. O bypass de dono para vídeos não-`pronto` fica **fora de escopo** desta fase.
  - Nova exceção `VideoNotReadyException` (`VIDEO_NOT_READY`, 409).
  - `VideosService.getStreamUrl`/`findReadyVideo` não recebem `userId` — rota `@Public()`, sem `@ApiBearerAuth`.
  - Teste e2e do 206 confirma Range real contra o MinIO (upload via multipart real, mesma infra do Grupo 1, com `status` forçado para `pronto` via UPDATE direto, já que o worker de processamento não roda neste e2e).

### SI-03.11 — Endpoint GET /videos/:id/download
- **Status:** completed
- **Tests:** 8 passing (3 unit + 2 e2e via spec `videos.plan.md`, mais os já existentes reexecutados)
- **Observations:**
  - Mesma regra da SI-03.10 (`findReadyVideo` compartilhado): rota `@Public()`, checagem 100% anônima de `status: pronto`, sem bypass de dono (mesma decisão do usuário na SI-03.10 aplicada aqui).
  - `StorageService.getPresignedGetUrl(key, 'attachment')` — reaproveita o parâmetro `responseContentDisposition` já existente desde a SI-03.3, sem alteração no `StorageService`.
  - E2E confirma `response-content-disposition=attachment` como query parameter real na URL assinada retornada pelo MinIO.

**Full test suites (verificação final da fase):**
- Testes unitários + integração: 190/190 passing (`docker compose exec nestjs-api npm test -- --runInBand`)
- Testes E2E: 72/72 passing (`docker compose exec nestjs-api npm run test:e2e -- --runInBand`)
- Type-check: `npx tsc --noEmit` limpo
- Lint: 150 erros pré-existentes (débito da Fase 02, intocado por instrução explícita do usuário) — nenhum erro novo introduzido por qualquer SI desta fase

**Fix pós-review — criação do bucket MinIO ausente em 2 specs:**
- Feedback externo apontou que `videos.service.integration-spec.ts` quebrava com `NoSuchBucket` ao subir a stack do zero, porque não garantia a criação do bucket no `beforeAll` (diferente de `storage.service.integration-spec.ts` e `video.processor.integration-spec.ts`, que já faziam isso). A suíte só fechava verde antes por depender da ordem de execução (o bucket já existir por efeito colateral de outra suíte).
- Investigação encontrou o mesmo problema em `test/videos.e2e-spec.ts` (15/20 testes falhando a partir de um bucket vazio).
- Corrigido replicando o padrão já estabelecido (`HeadBucketCommand`/`CreateBucketCommand` no `beforeAll`) nos dois arquivos. Validado removendo o bucket manualmente (`mc rb --force local/streamtube`) e reexecutando cada suíte isolada antes e depois da correção — confirmado failing→passing nas duas.
- Suíte completa reconfirmada verde a partir de um bucket vazio: 190/190 unit+integration, 72/72 e2e, `tsc --noEmit` limpo.
