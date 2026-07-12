import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `chan${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to rascunho', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Meu vídeo',
        storage_key: 'videos/some-id/original.mp4',
      }),
    );

    expect(video.status).toBe(VideoStatus.RASCUNHO);
  });

  it('should reject an invalid enum value for status', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "title", "status", "storage_key") VALUES ($1, $2, $3, $4)`,
        [channel.id, 'Vídeo inválido', 'nao-existe', 'videos/x/original.mp4'],
      ),
    ).rejects.toThrow();
  });

  it('should enforce not-null constraint on channel_id (FK)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: undefined,
          title: 'Sem canal',
          storage_key: 'videos/x/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should reject a channel_id that does not exist (FK constraint)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Canal inexistente',
          storage_key: 'videos/x/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow null thumbnail_key, duration_seconds, metadata, upload_id and error_message', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Vídeo em rascunho',
        storage_key: 'videos/some-id/original.mp4',
      }),
    );

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Vídeo com relação',
        storage_key: 'videos/some-id/original.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { channel_id: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
