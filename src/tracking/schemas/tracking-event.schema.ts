import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TrackingEventDocument = TrackingEvent & Document;

@Schema({ timestamps: true })
export class TrackingEvent {
  @Prop({ required: true })
  sessionId: string;

  @Prop({ required: true })
  visitorId: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({
    required: true,
    type: String,
    enum: [
      'pageview',
      'post_created',
      'comment_posted',
      'post_reported',
      'image_search_performed',
      'user_login',
      'user_registered',
    ],
  })
  type: string;

  @Prop()
  url?: string;

  @Prop()
  duration?: number;

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  @Prop({ required: true })
  timestamp: Date;
}

export const TrackingEventSchema = SchemaFactory.createForClass(TrackingEvent);

// TTL index : suppression automatique après 90 jours
TrackingEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
