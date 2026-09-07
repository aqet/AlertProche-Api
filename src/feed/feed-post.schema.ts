import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type FeedPostDocument = FeedPost & Document;
export type MediaType = 'image' | 'video' | 'mixed' | 'none';

@Schema({ timestamps: true })
export class FeedPost {
  /** Auteur du post */
  @Prop({
    type: {
      userId:   { type: Types.ObjectId, ref: 'User', required: true },
      pseudo:   { type: String, required: true },
      photoUrl: { type: String, default: null },
    },
    required: true,
  })
  author: {
    userId:   Types.ObjectId;
    pseudo:   string;
    photoUrl: string | null;
  };

  /** Texte du post (optionnel si un média est présent) */
  @Prop({ type: String, default: '', maxlength: 2000 })
  content: string;

  /** Type de média joint */
  @Prop({ type: String, enum: ['image', 'video', 'mixed', 'none'], default: 'none' })
  mediaType: MediaType;

  /** URLs des médias (Cloudinary) */
  @Prop({ type: [String], default: [] })
  mediaUrls: string[];

  /** Types individuels par URL (même index que mediaUrls) */
  @Prop({ type: [String], default: [] })
  mediaFileTypes: string[]; // 'image' | 'video' par fichier

  /** Métadonnées Cloudinary pour suppression fiable */
  @Prop({
    type: [{
      publicId:     { type: String },
      resourceType: { type: String, enum: ['image', 'video'] },
    }],
    default: [],
  })
  cloudinaryAssets: { publicId: string; resourceType: 'image' | 'video' }[];

  /** Localisation optionnelle */
  @Prop({ type: String, default: null, maxlength: 100 })
  location: string | null;

  /** Compteurs */
  @Prop({ type: Number, default: 0 })
  likesCount: number;

  @Prop({ type: Number, default: 0 })
  commentsCount: number;

  @Prop({ type: Number, default: 0 })
  sharesCount: number;

  /** IDs des utilisateurs ayant liké (pour éviter les doubles) */
  @Prop({ type: [Types.ObjectId], default: [] })
  likedBy: Types.ObjectId[];

  /** Commentaires du post */
  @Prop({
    type: [{
      _id:      { type: Types.ObjectId, default: () => new Types.ObjectId() },
      userId:   { type: Types.ObjectId, ref: 'User' },
      pseudo:   { type: String },
      photoUrl: { type: String, default: null },
      content:  { type: String, maxlength: 1000 },
      createdAt:{ type: Date, default: Date.now },
    }],
    default: [],
  })
  comments: {
    _id: Types.ObjectId;
    userId: Types.ObjectId;
    pseudo: string;
    photoUrl: string | null;
    content: string;
    createdAt: Date;
  }[];

  /** Modération */
  @Prop({ type: Boolean, default: true })
  isVisible: boolean;
}

export const FeedPostSchema = SchemaFactory.createForClass(FeedPost);

FeedPostSchema.index({ createdAt: -1 });
FeedPostSchema.index({ 'author.userId': 1 });
