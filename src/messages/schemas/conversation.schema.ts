import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ConversationDocument = Conversation & Document;

@Schema({ timestamps: true })
export class Conversation {
  /** Les 2 participants (toujours triés par ordre croissant des _id) */
  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'User', required: true })
  participants: Types.ObjectId[];

  /** Clé canonique "idA_idB" (triés) → 1 seul fil par paire d'utilisateurs */
  @Prop({ type: String, required: true, unique: true })
  pairKey: string;

  /** Date du dernier message (pour trier la boîte de réception) */
  @Prop({ type: Date, default: Date.now })
  lastMessageAt: Date;

  /** Aperçu du dernier message (affiché dans l'inbox) */
  @Prop({ type: String, default: '', maxlength: 120 })
  lastMessagePreview: string;

  /** Pseudo / photo figés de l'autre participant (évite un populate à chaque fois) */
  @Prop({
    type: {
      pseudo:   { type: String, default: '' },
      photoUrl: { type: String, default: null },
    },
    _id: false,
    default: undefined,
  })
  peerSnapshot?: { pseudo: string; photoUrl: string | null };
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

ConversationSchema.index({ participants: 1, lastMessageAt: -1 });
