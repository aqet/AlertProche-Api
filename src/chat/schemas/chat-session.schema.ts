import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ChatSessionDocument = ChatSession & Document;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

@Schema({ timestamps: true })
export class ChatSession {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, required: true, index: true })
  threadId: string;

  @Prop({
    type: [
      {
        role:      { type: String, enum: ['user', 'assistant'], required: true },
        content:   { type: String, required: true, maxlength: 4000 },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  messages: ChatMessage[];
}

export const ChatSessionSchema = SchemaFactory.createForClass(ChatSession);
ChatSessionSchema.index({ userId: 1, threadId: 1 }, { unique: true });
