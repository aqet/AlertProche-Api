import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatSession, ChatSessionSchema } from './schemas/chat-session.schema';
import { ChatStats, ChatStatsSchema } from './schemas/chat-stats.schema';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatSession.name, schema: ChatSessionSchema },
      { name: ChatStats.name,   schema: ChatStatsSchema   },
    ]),
    AiModule,
  ],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
