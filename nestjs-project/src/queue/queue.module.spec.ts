import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and resolve the video-processing Queue with attempts/backoff defaults', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBeDefined();
    expect(queue.defaultJobOptions?.attempts).toBe(3);
    expect(queue.defaultJobOptions?.backoff).toEqual({
      type: 'exponential',
      delay: 5000,
    });

    await module.close();
  }, 30000);
});
