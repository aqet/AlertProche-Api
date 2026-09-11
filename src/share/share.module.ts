import { Module } from '@nestjs/common';
import { ShareController } from './share.controller';
import { PostsModule } from '../posts/posts.module';
import { FeedModule } from '../feed/feed.module';

@Module({
  imports: [PostsModule, FeedModule],
  controllers: [ShareController],
})
export class ShareModule {}
