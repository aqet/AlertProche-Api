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
}

export const PostSchema = SchemaFactory.createForClass(Post);

PostSchema.index({ type: 1 });
PostSchema.index({ location: 1 });
PostSchema.index({ createdAt: -1 });
PostSchema.index({ isActive: 1 });
PostSchema.index({ isReported: 1 });
