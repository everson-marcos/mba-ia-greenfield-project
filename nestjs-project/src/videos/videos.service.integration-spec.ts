import { DataSource, Repository } from 'typeorm';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';
import {
  FileTooLargeException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from './videos.exceptions';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let queue: Queue;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource, channelRepository);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    storageService = moduleRef.get(StorageService);

    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      queue,
    );
  });

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vs${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('persists a draft video with status rascunho and a real multipart uploadId', async () => {
    const channel = await createUserWithChannel();

    const result = await videosService.create(channel.user_id, {
      title: 'Meu vídeo',
      fileSize: 1024,
    });

    expect(result.id).toBeDefined();
    expect(result.uploadId).toBeTruthy();
    expect(result.partSize).toBeGreaterThan(0);

    const persisted = await videoRepository.findOneBy({ id: result.id });
    expect(persisted?.status).toBe(VideoStatus.RASCUNHO);
    expect(persisted?.channel_id).toBe(channel.id);
    expect(persisted?.storage_key).toBe(`videos/${result.id}/original`);
    expect(persisted?.upload_id).toBe(result.uploadId);
  });

  it('rejects a fileSize above the 10GB limit without touching the database', async () => {
    const channel = await createUserWithChannel();

    await expect(
      videosService.create(channel.user_id, {
        title: 'Vídeo enorme',
        fileSize: 10 * 1024 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(FileTooLargeException);

    const videos = await videoRepository.find();
    expect(videos).toHaveLength(0);
  });

  describe('getUploadPartUrl', () => {
    it('returns a real presigned url for the owner of a rascunho video', async () => {
      const channel = await createUserWithChannel();
      const created = await videosService.create(channel.user_id, {
        title: 'Vídeo',
        fileSize: 1024,
      });

      const result = await videosService.getUploadPartUrl(
        channel.user_id,
        created.id,
        1,
      );

      expect(result.url).toContain(`videos/${created.id}/original`);
    });

    it('throws VideoNotFoundException for a non-existent video', async () => {
      const channel = await createUserWithChannel();

      await expect(
        videosService.getUploadPartUrl(
          channel.user_id,
          '00000000-0000-0000-0000-000000000000',
          1,
        ),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when a different user requests it', async () => {
      const ownerChannel = await createUserWithChannel();
      const otherChannel = await createUserWithChannel();
      const created = await videosService.create(ownerChannel.user_id, {
        title: 'Vídeo',
        fileSize: 1024,
      });

      await expect(
        videosService.getUploadPartUrl(otherChannel.user_id, created.id, 1),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('throws UploadAlreadyCompletedException when the video is not rascunho', async () => {
      const channel = await createUserWithChannel();
      const created = await videosService.create(channel.user_id, {
        title: 'Vídeo',
        fileSize: 1024,
      });
      await videoRepository.update(created.id, {
        status: VideoStatus.PROCESSANDO,
      });

      await expect(
        videosService.getUploadPartUrl(channel.user_id, created.id, 1),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });
  });

  describe('completeUpload', () => {
    it('completes a real multipart upload, marks processando, and enqueues a real job', async () => {
      const channel = await createUserWithChannel();
      const created = await videosService.create(channel.user_id, {
        title: 'Vídeo',
        fileSize: 5 * 1024 * 1024,
      });

      const partUrl = await videosService.getUploadPartUrl(
        channel.user_id,
        created.id,
        1,
      );
      const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
      const putResponse = await fetch(partUrl.url, {
        method: 'PUT',
        body: partBody,
      });
      const eTag = putResponse.headers.get('etag') as string;

      const result = await videosService.completeUpload(
        channel.user_id,
        created.id,
        [{ partNumber: 1, eTag }],
      );

      expect(result.status).toBe(VideoStatus.PROCESSANDO);

      const persisted = await videoRepository.findOneBy({ id: created.id });
      expect(persisted?.status).toBe(VideoStatus.PROCESSANDO);

      const jobs = await queue.getJobs(['waiting', 'completed']);
      expect(
        jobs.some(
          (job) => (job.data as { videoId: string }).videoId === created.id,
        ),
      ).toBe(true);
    });

    it('throws UploadAlreadyCompletedException on a second completion attempt', async () => {
      const channel = await createUserWithChannel();
      const created = await videosService.create(channel.user_id, {
        title: 'Vídeo',
        fileSize: 5 * 1024 * 1024,
      });
      const partUrl = await videosService.getUploadPartUrl(
        channel.user_id,
        created.id,
        1,
      );
      const partBody = Buffer.alloc(5 * 1024 * 1024, 'a');
      const putResponse = await fetch(partUrl.url, {
        method: 'PUT',
        body: partBody,
      });
      const eTag = putResponse.headers.get('etag') as string;
      await videosService.completeUpload(channel.user_id, created.id, [
        { partNumber: 1, eTag },
      ]);

      await expect(
        videosService.completeUpload(channel.user_id, created.id, [
          { partNumber: 1, eTag },
        ]),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });
  });
});
