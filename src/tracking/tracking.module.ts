import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { AnalyticsService } from './analytics.service';
import { GeoService } from './geo.service';
import { TrackingSession, TrackingSessionSchema } from './schemas/tracking-session.schema';
import { TrackingEvent, TrackingEventSchema } from './schemas/tracking-event.schema';
import { GeoCache, GeoCacheSchema } from './schemas/geo-cache.schema';
import { Post, PostSchema } from '../schemas/post.schema';
import { User, UserSchema } from '../schemas/user.schema';
import { Comment, CommentSchema } from '../schemas/comment.schema';
import { Conversation, ConversationSchema } from '../messages/schemas/conversation.schema';
import { Message, MessageSchema } from '../messages/schemas/message.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TrackingSession.name, schema: TrackingSessionSchema },
      { name: TrackingEvent.name, schema: TrackingEventSchema },
      { name: GeoCache.name, schema: GeoCacheSchema },
      { name: Post.name, schema: PostSchema },
      { name: User.name, schema: UserSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  controllers: [TrackingController],
  providers: [TrackingService, AnalyticsService, GeoService],
  exports: [TrackingService],
})
export class TrackingModule {}
