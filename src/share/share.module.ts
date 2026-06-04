import { Module } from '@nestjs/common';
import { ShareController } from './share.controller';
import { PostsModule } from '../posts/posts.module';

@Module({
  imports: [PostsModule],
  controllers: [ShareController],
})
export class ShareModule {}
