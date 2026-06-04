import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReviewDocument = Review & Document;

@Schema({ timestamps: true })
export class Review {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  author_id: Types.ObjectId | null;

  @Prop({ trim: true, maxlength: 50, default: null })
  pseudo: string | null;

  @Prop({ required: true, min: 1, max: 5 })
  rating: number;

  @Prop({ required: true, trim: true, minlength: 10, maxlength: 1000 })
  message: string;

  @Prop({ default: false })
  isAnonymous: boolean;

  @Prop({ default: true })
  isVisible: boolean;
}

export const ReviewSchema = SchemaFactory.createForClass(Review);

ReviewSchema.index({ createdAt: -1 });
ReviewSchema.index({ rating: 1 });
ReviewSchema.index({ isVisible: 1 });
