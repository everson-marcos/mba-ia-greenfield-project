import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { CoreModule } from '../core/core.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessor } from '../videos/video.processor';

@Module({
  imports: [
    CoreModule,
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
    StorageModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
