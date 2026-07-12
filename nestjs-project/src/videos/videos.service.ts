import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import {
  MAX_VIDEO_FILE_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';
import { FileTooLargeException } from './videos.exceptions';

export interface CreateVideoResult {
  id: string;
  uploadId: string;
  partSize: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
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
}
