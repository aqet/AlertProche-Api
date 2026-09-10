import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ChatStatsDocument = ChatStats & Document;

/**
 * Document unique (singleton) qui accumule toutes les stats du chatbot.
 * Identifié par la clé fixe "global".
 */
@Schema({ timestamps: true })
export class ChatStats {
  /** Clé singleton — toujours "global" */
  @Prop({ type: String, default: 'global', unique: true })
  key: string;

  /** Nombre total de sessions utilisateurs connectés (une par threadId unique) */
  @Prop({ type: Number, default: 0 })
  totalAuthSessions: number;

  /** Nombre total de sessions visiteurs non connectés */
  @Prop({ type: Number, default: 0 })
  totalGuestSessions: number;

  /** Nombre total de messages envoyés par des utilisateurs connectés */
  @Prop({ type: Number, default: 0 })
  totalAuthMessages: number;

  /** Nombre total de messages envoyés par des visiteurs */
  @Prop({ type: Number, default: 0 })
  totalGuestMessages: number;
}

export const ChatStatsSchema = SchemaFactory.createForClass(ChatStats);
