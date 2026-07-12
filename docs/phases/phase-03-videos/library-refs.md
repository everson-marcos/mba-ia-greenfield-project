---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-12T11:40:00"
  "bullmq":
    version: "^5.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-12T11:40:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-12T11:40:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-12T11:40:00"
  "@aws-sdk/lib-storage":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-12T11:40:00"
  "fluent-ffmpeg":
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-12T11:40:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-12T11:35:42"
---

# phase-03-videos — Library References

Distilled Context7 docs for the libraries newly decided in this phase (TD-01, TD-02, TD-05). Only the surfaces relevant to this phase's usage are kept — full docs live upstream.

### @nestjs/bullmq

**Module setup, injecting `ConfigService`** (matches the project's `registerAs`/`ConfigType` convention — pass connection options via `forRootAsync`):

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: {
      host: config.host,   // Compose service name, e.g. "redis" — never "localhost"
      port: config.port,
    },
  }),
})
```

**Registering the queue** (do the same for the queue registration, and per TD-07 attach `defaultJobOptions` with `attempts` + `backoff`):

```typescript
BullModule.registerQueueAsync({
  name: 'video-processing',
  useFactory: () => ({
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  }),
})
```

**Processor pattern** — extend `WorkerHost`, decorate with `@Processor(queueName)`:

```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    // ffprobe + screenshots + status update
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // 'failed' fires per-attempt; check job.attemptsMade === job.opts.attempts
    // to know retries are exhausted (TD-07).
  }
}
```

**Enqueuing a job** — inject via `@InjectQueue('video-processing')`, then:

```typescript
await this.videoQueue.add('process-video', { videoId });
```

**Constants note:** `@nestjs/bullmq` uses distinct metadata keys (`PROCESSOR_METADATA`, `WORKER_METADATA`, `ON_WORKER_EVENT_METADATA`) from the legacy `@nestjs/bull` package — do not mix imports from `@nestjs/bull` into this module; import everything from `@nestjs/bullmq`.

### bullmq

**Awaiting completion in integration tests (TD-08)** — use `QueueEvents.waitUntilFinished(job)`, not polling:

```typescript
import { QueueEvents } from 'bullmq';

const queueEvents = new QueueEvents('video-processing', { connection });
const job = await videoQueue.add('process-video', { videoId });
await job.waitUntilFinished(queueEvents); // resolves when the job completes or throws on failure
```

`bullmq` is the underlying engine `@nestjs/bullmq` wraps — `Job`, `Queue`, `Worker`, `QueueEvents` types and the `attempts`/`backoff` job-option shapes all come from this package directly (re-exported/used through `@nestjs/bullmq` for DI, but `QueueEvents` for test-side awaiting is typically imported straight from `bullmq`).

### @aws-sdk/client-s3

**Client setup for MinIO** (custom endpoint + path-style — required for MinIO, not needed for real AWS S3 in production):

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  endpoint: config.endpoint,       // e.g. http://minio:9000 — Compose service name
  forcePathStyle: true,            // required for MinIO; omit/false for real AWS S3
  region: 'us-east-1',             // MinIO ignores region but the SDK requires a value
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
});
```

**Multipart upload orchestration (TD-03)** — 3-step handshake the API performs:

1. `CreateMultipartUploadCommand({ Bucket, Key })` → returns `UploadId`.
2. Per part: sign a `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` via `getSignedUrl()` (from `@aws-sdk/s3-request-presigner`) and hand the URL to the client — the API never sees the bytes.
3. `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] } })` — client reports back each part's `ETag` from its PUT response headers, API completes the upload.

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

const { UploadId } = await s3Client.send(
  new CreateMultipartUploadCommand({ Bucket, Key }),
);

await s3Client.send(
  new CompleteMultipartUploadCommand({
    Bucket, Key, UploadId,
    MultipartUpload: { Parts: parts /* [{ ETag, PartNumber }] collected from client */ },
  }),
);
```

**Presigned GET (TD-06, streaming/download)** uses `GetObjectCommand` from this package together with `getSignedUrl()` from `@aws-sdk/s3-request-presigner` — see that section below.

### @aws-sdk/s3-request-presigner

**`getSignedUrl()`** signs any `client-s3` command into a time-limited URL — used for both `UploadPartCommand` (upload direction, TD-03) and `GetObjectCommand` (download direction, TD-06):

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const partUrl = await getSignedUrl(
  s3Client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: 1 }),
  { expiresIn: 3600 },
);

const getUrl = await getSignedUrl(
  s3Client,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: 3600 },
);
// S3/MinIO natively handles Range requests + 206 Partial Content on this URL —
// no manual Range parsing needed in the NestJS controller.
```

For the download endpoint, pass `ResponseContentDisposition: 'attachment'` on the `GetObjectCommand` to force a download instead of inline playback.

### @aws-sdk/lib-storage

**`Upload` class** — not this phase's main upload path (that's the client-orchestrated multipart handshake above, per TD-03), but useful for whole-file uploads the worker performs itself, e.g. uploading the generated thumbnail (small, no multipart handshake needed):

```typescript
import { Upload } from '@aws-sdk/lib-storage';

const upload = new Upload({
  client: s3Client,
  params: { Bucket, Key, Body: thumbnailBuffer },
});
await upload.done();
```

### fluent-ffmpeg

**Binary path** — `ffmpeg`/`ffprobe` must be installed in the worker's container image (not present in `node:25.6.0-slim` by default; add via `apt install ffmpeg`, which provides both binaries). If not on `PATH`, set explicitly at startup:

```typescript
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');
```

**Metadata + duration extraction**:

```typescript
ffmpeg.ffprobe(filePath, (err, data) => {
  const durationSeconds = data.format.duration;
  const { width, height, codec_name } = data.streams.find(s => s.codec_type === 'video');
});
```

**Thumbnail generation from a frame**:

```typescript
ffmpeg(filePath)
  .on('error', (err, stdout, stderr) => {
    // MUST handle this event — unhandled 'error' crashes the process.
    // Log stdout/stderr for debugging; feeds TD-07's failure/erro path.
  })
  .on('end', () => { /* thumbnail written */ })
  .screenshots({
    timestamps: ['50%'],   // pick the mid-point frame
    filename: 'thumbnail.jpg',
    folder: tmpOutputDir,
    size: '640x360',
  });
```

**Error handling is mandatory**: fluent-ffmpeg emits an `'error'` event (not a thrown exception) on FFmpeg failure — this is the hook TD-07's automatic-retry path relies on (the processor's `catch`/error handling must listen for this event and reject/throw so BullMQ registers the job as failed and retries per `attempts`/`backoff`).
