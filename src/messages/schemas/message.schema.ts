import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type MessageDocument = Message & Document;

@Schema({ timestamps: true })
export class Message {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Conversation', required: true })
  conversation: Types.ObjectId;

  /** Émetteur du message */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  sender: Types.ObjectId;

  /** Texte du message (modéré avant enregistrement) */
  @Prop({ type: String, required: true, maxlength: 2000 })
  text: string;

  /** Date de récupération du message par le destinataire (accusé de réception) */
  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  /** Date de lecture par le destinataire (null = non lu) */
  @Prop({ type: Date, default: null })
  readAt: Date | null;

  /** Ajouté par { timestamps: true } (typage uniquement) */
  createdAt: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// Fil de discussion chronologique (polling delta via createdAt)
MessageSchema.index({ conversation: 1, createdAt: -1 });
// Compteur "non lus" de l'inbox
MessageSchema.index({ conversation: 1, sender: 1, readAt: 1 });
