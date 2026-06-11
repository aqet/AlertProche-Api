import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { Comment, CommentSchema } from '../schemas/comment.schema';
import { Post, PostSchema } from '../schemas/post.schema';
import { ModerationModule } from '../common/moderation/moderation.module';
import { AiModule } from 'src/ai/ai.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Comment.name, schema: CommentSchema },
      { name: Post.name, schema: PostSchema },
    ]),
    ModerationModule,
    AiModule
  ],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
