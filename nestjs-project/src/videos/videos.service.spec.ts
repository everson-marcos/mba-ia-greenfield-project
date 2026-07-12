import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';
import {
  FileTooLargeException,
  InvalidUploadPartException,
  MultipartUploadFailedException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from './videos.exceptions';

function makeChannel(id = 'channel-id'): Channel {
  return { id, user_id: 'user-id' } as Channel;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    channel_id: 'channel-id',
    title: 'Vídeo',
    status: VideoStatus.RASCUNHO,
    storage_key: 'videos/video-id/original',
    upload_id: 'upload-123',
    ...overrides,
  } as Video;
}

interface VideoRepositoryMock {
  create: jest.Mock<Partial<Video>, [Partial<Video>]>;
  save: jest.Mock<Promise<Video>, [Partial<Video>]>;
  update: jest.Mock<Promise<void>, [string, Partial<Video>]>;
  findOneBy: jest.Mock<Promise<Video | null>, [Partial<Video>]>;
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
    findOneBy: jest.fn<Promise<Video | null>, [Partial<Video>]>(),
  };
}

function makeChannelsService(): jest.Mocked<
  Pick<ChannelsService, 'findByUserId'>
> {
  return { findByUserId: jest.fn() };
}

function makeStorageService(): jest.Mocked<
  Pick<
    StorageService,
    'createMultipartUpload' | 'getUploadPartUrl' | 'completeMultipartUpload'
  >
> {
  return {
    createMultipartUpload: jest.fn(),
    getUploadPartUrl: jest.fn(),
    completeMultipartUpload: jest.fn(),
  };
}

function makeQueue(): jest.Mocked<Pick<Queue, 'add'>> {
  return { add: jest.fn() };
}

function buildService(
  repo: ReturnType<typeof makeRepo>,
  channelsService: ReturnType<typeof makeChannelsService>,
  storageService: ReturnType<typeof makeStorageService>,
  queue: ReturnType<typeof makeQueue> = makeQueue(),
): VideosService {
  return new VideosService(
    repo as unknown as Repository<Video>,
    channelsService as unknown as ChannelsService,
    storageService as unknown as StorageService,
    queue as unknown as Queue,
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

  describe('getUploadPartUrl', () => {
    it('returns a presigned url when the requester owns the rascunho video', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      storageService.getUploadPartUrl.mockResolvedValue('https://signed-url');
      const service = buildService(repo, channelsService, storageService);

      const result = await service.getUploadPartUrl('user-id', 'video-id', 1);

      expect(storageService.getUploadPartUrl).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-123',
        1,
      );
      expect(result).toEqual({ url: 'https://signed-url' });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(null);
      const channelsService = makeChannelsService();
      const storageService = makeStorageService();
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.getUploadPartUrl('user-id', 'missing-id', 1),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when the requester is not the owner', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(
        makeChannel('other-channel-id'),
      );
      const storageService = makeStorageService();
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.getUploadPartUrl('user-id', 'video-id', 1),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('throws UploadAlreadyCompletedException when the video is not rascunho', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSANDO }),
      );
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.getUploadPartUrl('user-id', 'video-id', 1),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, eTag: 'etag-1' }];

    it('completes the upload, marks the video processando, and enqueues the job', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      const queue = makeQueue();
      const service = buildService(
        repo,
        channelsService,
        storageService,
        queue,
      );

      const result = await service.completeUpload('user-id', 'video-id', parts);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-123',
        parts,
      );
      expect(repo.update).toHaveBeenCalledWith('video-id', {
        status: VideoStatus.PROCESSANDO,
      });
      expect(queue.add).toHaveBeenCalledWith('process-video', {
        videoId: 'video-id',
      });
      expect(result).toEqual({
        id: 'video-id',
        status: VideoStatus.PROCESSANDO,
      });
    });

    it('throws UploadAlreadyCompletedException when the video is not rascunho', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSANDO }),
      );
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow(UploadAlreadyCompletedException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws InvalidUploadPartException when storage reports an InvalidPart error', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      const invalidPartError = new Error('part mismatch');
      invalidPartError.name = 'InvalidPart';
      storageService.completeMultipartUpload.mockRejectedValue(
        invalidPartError,
      );
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow(InvalidUploadPartException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws MultipartUploadFailedException for any other storage error', async () => {
      const repo = makeRepo();
      repo.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = makeChannelsService();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      storageService.completeMultipartUpload.mockRejectedValue(
        new Error('storage unreachable'),
      );
      const service = buildService(repo, channelsService, storageService);

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow(MultipartUploadFailedException);
    });
  });
});
