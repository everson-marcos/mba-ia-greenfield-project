import { DataSource, Repository } from 'typeorm';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
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
import { VideosService } from './videos.service';
import { FileTooLargeException } from './videos.exceptions';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;
  let channelsService: ChannelsService;

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
    const storageService = moduleRef.get(StorageService);

    videosService = new VideosService(
      videoRepository,
      channelsService,
      storageService,
    );
  });

  afterAll(async () => {
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
});
