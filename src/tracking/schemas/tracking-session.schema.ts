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
  countryCode: string;

  @Prop()
  city: string;

  @Prop({ type: String, enum: ['local', 'api', 'none'], default: 'none' })
  geoSource: string;

  @Prop({ default: false })
  isBot: boolean;

  @Prop({ default: false })
  isStaff: boolean;

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

// Index d'agrégation : périodes, visiteurs uniques et filtres staff / robots.
TrackingSessionSchema.index({ startedAt: -1 });
TrackingSessionSchema.index({ visitorId: 1, startedAt: -1 });
TrackingSessionSchema.index({ isBot: 1, startedAt: -1 });
TrackingSessionSchema.index({ isStaff: 1, startedAt: -1 });

// TTL index : suppression automatique après 90 jours
TrackingSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
