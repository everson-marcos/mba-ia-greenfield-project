import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { FileTooLargeException } from './videos.exceptions';

function makeChannel(id = 'channel-id'): Channel {
  return { id, user_id: 'user-id' } as Channel;
}

interface VideoRepositoryMock {
  create: jest.Mock<Partial<Video>, [Partial<Video>]>;
  save: jest.Mock<Promise<Video>, [Partial<Video>]>;
  update: jest.Mock<Promise<void>, [string, Partial<Video>]>;
}

function makeRepo(): VideoRepositoryMock {
  return {
    create: jest.fn((data: Partial<Video>) => data),
    save: jest.fn((data: Partial<Video>) =>
      Promise.resolve({ id: 'video-id', ...data } as Video),
    ),
    update: jest
      .fn<Promise<void>, [string, Partial<Video>]>()
      .mockResolvedValue(undefined),
  };
}

function makeChannelsService(): jest.Mocked<
  Pick<ChannelsService, 'findByUserId'>
> {
  return { findByUserId: jest.fn() };
}

function makeStorageService(): jest.Mocked<
  Pick<StorageService, 'createMultipartUpload'>
> {
  return { createMultipartUpload: jest.fn() };
}

function buildService(
  repo: ReturnType<typeof makeRepo>,
  channelsService: ReturnType<typeof makeChannelsService>,
  storageService: ReturnType<typeof makeStorageService>,
): VideosService {
  return new VideosService(
    repo as unknown as Repository<Video>,
    channelsService as unknown as ChannelsService,
    storageService as unknown as StorageService,
  );
}

describe('VideosService', () => {
  describe('create', () => {
    it('throws FileTooLargeException when fileSize exceeds the 10GB limit', async () => {
      const repo = makeRepo();
      const channelsService = makeChannelsService();
      const storageService = makeStorageService();
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.create('user-id', {
          title: 'Vídeo',
          fileSize: 10 * 1024 * 1024 * 1024 + 1,
        }),
      ).rejects.toThrow(FileTooLargeException);

      expect(channelsService.findByUserId).not.toHaveBeenCalled();
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('creates the draft video, initiates the multipart upload, and returns id/uploadId/partSize', async () => {
      const repo = makeRepo();
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      storageService.createMultipartUpload.mockResolvedValue('upload-123');
      const service = buildService(repo, channelsService, storageService);

      const result = await service.create('user-id', {
        title: 'Meu vídeo',
        fileSize: 1024,
      });

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-id');
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-id',
          title: 'Meu vídeo',
        }),
      );
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/original',
      );
      expect(repo.update).toHaveBeenCalledWith('video-id', {
        storage_key: 'videos/video-id/original',
        upload_id: 'upload-123',
      });
      expect(result.id).toBe('video-id');
      expect(result.uploadId).toBe('upload-123');
      expect(typeof result.partSize).toBe('number');
    });

    it('throws when the authenticated user has no channel', async () => {
      const repo = makeRepo();
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(null);
      const storageService = makeStorageService();
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.create('user-id', { title: 'Vídeo', fileSize: 1024 }),
      ).rejects.toThrow('Authenticated user has no channel');
    });
  });
});
