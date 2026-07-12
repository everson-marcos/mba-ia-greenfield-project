import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CompletedPartDto } from './dto/completed-part.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  MAX_VIDEO_FILE_SIZE_BYTES,
  PROCESS_VIDEO_JOB,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import {
  FileTooLargeException,
  InvalidUploadPartException,
  MultipartUploadFailedException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from './videos.exceptions';

export interface CreateVideoResult {
  id: string;
  uploadId: string;
  partSize: number;
}

export interface VideoStatusResult {
  id: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  errorMessage: string | null;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue,
  ) {}

  async create(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResult> {
    if (dto.fileSize > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error('Authenticated user has no channel');
    }

    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channel.id,
        title: dto.title,
        storage_key: '',
      }),
    );

    const storageKey = `videos/${video.id}/original`;
    const uploadId =
      await this.storageService.createMultipartUpload(storageKey);

    await this.videoRepository.update(video.id, {
      storage_key: storageKey,
      upload_id: uploadId,
    });

    return { id: video.id, uploadId, partSize: UPLOAD_PART_SIZE_BYTES };
  }

  async getUploadPartUrl(
    userId: string,
    videoId: string,
    partNumber: number,
  ): Promise<{ url: string }> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.RASCUNHO) {
      throw new UploadAlreadyCompletedException();
    }

    const url = await this.storageService.getUploadPartUrl(
      video.storage_key,
      video.upload_id as string,
      partNumber,
    );
    return { url };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    parts: CompletedPartDto[],
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.findOwnedVideo(userId, videoId);
    if (video.status !== VideoStatus.RASCUNHO) {
      throw new UploadAlreadyCompletedException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        parts.map((part) => ({
          partNumber: part.partNumber,
          eTag: part.eTag,
        })),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'InvalidPart') {
        throw new InvalidUploadPartException();
      }
      throw new MultipartUploadFailedException();
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSANDO,
    });
    await this.videoQueue.add(PROCESS_VIDEO_JOB, { videoId: video.id });

    return { id: video.id, status: VideoStatus.PROCESSANDO };
  }

  async findOne(userId: string, videoId: string): Promise<VideoStatusResult> {
    const video = await this.findOwnedVideo(userId, videoId);
    return {
      id: video.id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      errorMessage: video.error_message,
    };
  }

  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new VideoNotOwnedException();
    }

    return video;
  }
}
