> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real MinIO (S3-compatible) via Docker in both development and tests. Real AWS S3 in production — same client code, only `endpoint`/credentials change (see `docs/decisions/technical-decisions-phase-03-videos.md` TD-02).

**Approach:**
- Client: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage` (AWS SDK v3 — true S3-protocol client, works against MinIO via `endpoint` + `forcePathStyle: true`)
- In tests, hit the real `minio` Compose service — no mocking, no local-filesystem fallback. Consistent with the project's "don't mock what you can run for real in Compose" policy.
- Use a dedicated test bucket (or a `test/` key prefix within the phase's single bucket) and clean up test objects in `afterAll`/`afterEach`

**Setup pattern:**
```typescript
// In test module setup
const s3Client = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'minioadmin',
  },
});
```

**Integration test:**
```typescript
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

describe('StorageService (integration)', () => {
  const testKey = `test/${crypto.randomUUID()}.txt`;

  afterEach(async () => {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));
  });

  it('should upload and retrieve a file from real MinIO', async () => {
    await s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: testKey, Body: Buffer.from('test content') }),
    );

    const { Body } = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: testKey }));
    expect(await Body.transformToString()).toBe('test content');
  });
});
```

---

## Message Queue — Real BullMQ + Redis (Docker)

**Strategy:** Real BullMQ backed by a real Redis instance via Docker, in both development and tests (see `docs/decisions/technical-decisions-phase-03-videos.md` TD-01, TD-08). No mocked queue, no fake in-memory substitute — retry/backoff behavior (TD-07) is only meaningfully tested against the real queue.

**Configure:**
- A `redis` service in `compose.yaml` (Compose service name — never `localhost` inside containers, per `CLAUDE.md`'s Docker Networking rule)
- `@nestjs/bullmq` + `bullmq` — see `docs/phases/phase-03-videos/library-refs.md` for setup snippets
- Test isolation: use a dedicated test queue name (or a per-test-run prefix) and clean queues between tests
- For publisher tests: assert the job is enqueued with correct data
- For consumer tests: submit a job and await real completion via `QueueEvents.waitUntilFinished(job)` — not polling

**Setup pattern:**
```typescript
// In test module
BullModule.forRootAsync({
  useFactory: () => ({
    connection: {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
  }),
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

```typescript
describe('VideoProcessing (integration - queue)', () => {
  it('should enqueue a processing job on upload', async () => {
    await videoService.upload(videoData);

    const queue = module.get<Queue>(getQueueToken('video-processing'));
    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual(
      expect.objectContaining({ videoId: expect.any(String) }),
    );
  });

  it('should process the job and update video status to pronto', async () => {
    const job = await queue.add('process-video', { videoId });
    await job.waitUntilFinished(queueEvents); // real worker, real ffmpeg, bounded by a small fixture video

    const video = await videoRepository.findOneBy({ id: videoId });
    expect(video.status).toBe('pronto');
  });
});
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
