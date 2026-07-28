import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AppDownloadDocument = AppDownload & Document;

@Schema({ collection: 'app_downloads', timestamps: true })
export class AppDownload {
  @Prop({ required: true, unique: true, default: 'android-app' })
  key: string;

  @Prop({ default: 0 })
  count: number;
}

export const AppDownloadSchema = SchemaFactory.createForClass(AppDownload);
