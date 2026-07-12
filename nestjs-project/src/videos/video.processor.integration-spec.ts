import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { WorkerModule } from '../worker/worker.module';
import { Video, VideoStatus } from './entities/video.entity';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const bucket = process.env.STORAGE_BUCKET ?? 'streamtube';
const redisConnection = {
  host: process.env.REDIS_HOST ?? 'redis',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

describe('VideoProcessor (integration)', () => {
  jest.setTimeout(60000);

  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let moduleRef: TestingModule;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let s3Client: S3Client;
  let fixturesDir: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    queue = new Queue(VIDEO_PROCESSING_QUEUE, { connection: redisConnection });
    queueEvents = new QueueEvents(VIDEO_PROCESSING_QUEUE, {
      connection: redisConnection,
    });
    await queueEvents.waitUntilReady();

    s3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? 'minioadmin',
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? 'minioadmin',
      },
    });
    try {
      await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
    }

    fixturesDir = await mkdtemp(join(tmpdir(), 'video-processor-'));
  });

  afterAll(async () => {
    await queue.close();
    await queueEvents.close();
    await moduleRef.close();
    await dataSource.destroy();
    await rm(fixturesDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createProcessingVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_proc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vp${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Vídeo',
        status: VideoStatus.PROCESSANDO,
        storage_key: `videos/pending-${counter}/original`,
      }),
    );
  }

  async function generateFixtureVideo(destPath: string): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      destPath,
    ]);
  }

  async function waitForStatusChange(
    id: string,
    fromStatus: VideoStatus,
    timeoutMs = 20000,
  ): Promise<Video> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = await videoRepository.findOneBy({ id });
      if (current && current.status !== fromStatus) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for video ${id} to leave ${fromStatus}`);
  }

  it('processes a valid video: status pronto, duration_seconds and thumbnail_key set', async () => {
    const video = await createProcessingVideo();
    const localPath = join(fixturesDir, `${video.id}.mp4`);
    await generateFixtureVideo(localPath);
    const body = await readFile(localPath);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: video.storage_key,
        Body: body,
      }),
    );

    const job = await queue.add(PROCESS_VIDEO_JOB, { videoId: video.id });
    await job.waitUntilFinished(queueEvents);

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted?.status).toBe(VideoStatus.PRONTO);
    expect(persisted?.duration_seconds).toBeGreaterThan(0);
    expect(persisted?.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(persisted?.metadata?.width).toBe(320);
    expect(persisted?.metadata?.height).toBe(240);
    expect(typeof persisted?.metadata?.codec).toBe('string');

    const thumbnailHead = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: persisted?.thumbnail_key as string,
      }),
    );
    expect(thumbnailHead.ContentLength).toBeGreaterThan(0);

    await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: video.storage_key }),
    );
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: persisted?.thumbnail_key as string,
      }),
    );
  });

  it('exhausts the 3 BullMQ retries for a corrupted video and marks status erro', async () => {
    const video = await createProcessingVideo();
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: video.storage_key,
        Body: Buffer.from('this is not a valid video file'),
      }),
    );

    const job = await queue.add(PROCESS_VIDEO_JOB, { videoId: video.id });
    await expect(job.waitUntilFinished(queueEvents)).rejects.toThrow();

    const persisted = await waitForStatusChange(
      video.id,
      VideoStatus.PROCESSANDO,
    );
    expect(persisted.status).toBe(VideoStatus.ERRO);
    expect(persisted.error_message).toBeTruthy();

    await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: video.storage_key }),
    );
  });
});
