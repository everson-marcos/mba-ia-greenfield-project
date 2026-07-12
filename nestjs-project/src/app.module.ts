import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { StorageModule } from './storage/storage.module';
import { QueueModule } from './queue/queue.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [CoreModule, AuthModule, StorageModule, QueueModule, VideosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
