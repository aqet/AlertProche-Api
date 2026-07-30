import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationDocument = Notification & Document;
export type NotificationType = 'Disparition' | 'Abus' | 'Prevention' | 'Appel à l\'aide';

@Schema({ timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  token: string;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ type: 1 });
NotificationSchema.index({ location: 1 });
NotificationSchema.index({ createdAt: -1 });
NotificationSchema.index({ isActive: 1 });
NotificationSchema.index({ isReported: 1 });
