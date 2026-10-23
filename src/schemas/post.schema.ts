import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PostDocument = Post & Document;
export type PostType = 'Disparition' | 'Abus' | 'Prevention' | 'Appel à l\'aide';

@Schema({ timestamps: true })
export class Post {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  author_id: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 150 })
  title: string;

  @Prop({ required: true })
  content: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  location: string;

  @Prop({ type: String, enum: ['Disparition', 'Abus', 'Prevention', 'Appel à l\'aide'], required: true })
  type: PostType;

  @Prop({ default: false })
  isAnonymous: boolean;

  @Prop({ default: null })
  image_url: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isReported: boolean;

  @Prop({ type: [String], default: [] })
  reportReasons: string[];

  /**
   * IDs des membres ayant signalé l'alerte.
   * Sert au signalement cumulatif : on sait qui et combien.
   */
  @Prop({ type: [String], default: [] })
  reportedBy: string[];

  /**
   * IDs des membres ayant confirmé l'authenticité de l'alerte.
   * Un membre ne peut avoir qu'une seule entrée (vote unique par personne).
   */
  @Prop({ type: [String], default: [] })
  trustVotes: string[];

  /** Nombre de votes de confirmation (dénormalisé pour le tri par fiabilité). */
  @Prop({ default: 0 })
  trustVoteCount: number;

  /** Nombre de vues uniques de l'alerte (dénominateur du taux de confirmation). */
  @Prop({ default: 0 })
  viewsCount: number;

  /** L'alerte a été jugée fausse par la modération (1 sanction). */
  @Prop({ default: false })
  isFalseAlert: boolean;

  @Prop({ type: Number, required: false })
  targetAmount?: number;

  @Prop({ type: Number, default: 0 })
  raisedAmount: number;

  @Prop({ type: Number, default: 0 })
  withdrawnAmount: number;

  @Prop({ default: false })
  isResolved: boolean;

  @Prop({ type: Date, default: null })
  resolvedAt: Date;

  @Prop({ type: String, default: null })
  resolvedBy: string;
}

export const PostSchema = SchemaFactory.createForClass(Post);

PostSchema.index({ type: 1 });
PostSchema.index({ location: 1 });
PostSchema.index({ createdAt: -1 });
PostSchema.index({ isActive: 1 });
PostSchema.index({ isReported: 1 });
PostSchema.index({ isResolved: 1 });
PostSchema.index({ trustVoteCount: -1 });
