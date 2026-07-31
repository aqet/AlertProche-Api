import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { Post, PostSchema } from '../schemas/post.schema';
import { Comment, CommentSchema } from '../schemas/comment.schema';
import { ModerationModule } from '../common/moderation/moderation.module';
import { CloudinaryModule } from '../common/cloudinary/cloudinary.module';
import { AiModule } from 'src/ai/ai.module';
import { MailModule } from 'src/mail/mail.module';
import { AppDownload, AppDownloadSchema } from '../schemas/app-download.schema';
import { User, UserSchema } from 'src/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: AppDownload.name, schema: AppDownloadSchema },
    ]),
    ModerationModule,
    CloudinaryModule,
    AiModule,
    MailModule
  ],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}
