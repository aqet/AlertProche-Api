import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TrackingSessionDocument = TrackingSession & Document;

@Schema({ timestamps: true })
export class TrackingSession {
  @Prop({ required: true })
  sessionId: string;

  @Prop({ required: true })
  visitorId: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ required: true })
  ipHash: string;

  @Prop()
  country: string;

  @Prop()
  city: string;

  @Prop({ type: String, enum: ['mobile', 'tablet', 'desktop'] })
  device: string;

  @Prop()
  browser: string;

  @Prop()
  os: string;

  @Prop()
  entryPage: string;

  @Prop()
  exitPage?: string;

  @Prop({ type: String, enum: ['Direct', 'Organic Search', 'Social', 'Referral', 'Unknown'] })
  trafficSource: string;

  @Prop({ default: false })
  isNewVisitor: boolean;

  @Prop()
  duration?: number;

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  endedAt?: Date;
}

export const TrackingSessionSchema = SchemaFactory.createForClass(TrackingSession);

// TTL index : suppression automatique après 90 jours
TrackingSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
