import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';

export interface ProcessVideoJobData {
  videoId: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video) {
      throw new Error(`Video ${job.data.videoId} not found`);
    }

    const sourceUrl = await this.storageService.getPresignedGetUrl(
      video.storage_key,
    );
    const probeData = await this.probe(sourceUrl);
    const thumbnailPath = await this.generateThumbnail(sourceUrl);

    try {
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      const thumbnailBuffer = await readFile(thumbnailPath);
      await this.storageService.uploadFile(thumbnailKey, thumbnailBuffer);

      const videoStream = probeData.streams.find(
        (stream) => stream.codec_type === 'video',
      );

      await this.videoRepository.update(video.id, {
        status: VideoStatus.PRONTO,
        duration_seconds: probeData.format.duration ?? null,
        metadata: videoStream
          ? {
              width: videoStream.width,
              height: videoStream.height,
              codec: videoStream.codec_name,
            }
          : null,
        thumbnail_key: thumbnailKey,
      });
    } finally {
      await rm(thumbnailPath, { force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const totalAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < totalAttempts) {
      return;
    }
    await this.videoRepository.update(job.data.videoId, {
      status: VideoStatus.ERRO,
      error_message: error.message,
    });
  }

  private probe(sourceUrl: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(sourceUrl, (err: Error | null, data: FfprobeData) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  }

  private generateThumbnail(sourceUrl: string): Promise<string> {
    const folder = tmpdir();
    const filename = `${randomUUID()}.jpg`;
    return new Promise((resolve, reject) => {
      ffmpeg(sourceUrl)
        .on('error', (err: Error) => reject(err))
        .on('end', () => resolve(join(folder, filename)))
        .screenshots({
          timestamps: ['50%'],
          filename,
          folder,
          size: '640x360',
        });
    });
  }
}
