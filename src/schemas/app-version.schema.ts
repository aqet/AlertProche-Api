import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AppVersionDocument = AppVersion & Document;

@Schema({ timestamps: true })
export class AppVersion {
  /** Version la plus récente disponible - ex: "1.2.0" */
  @Prop({ required: true, trim: true })
  latestVersion: string;

  /** Version minimale supportée (en dessous = hard update bloquant) - ex: "1.1.0" */
  @Prop({ required: true, trim: true })
  minSupportedVersion: string;

  /** Lien de téléchargement direct (APK ou Play Store) */
  @Prop({ type: String, default: null })
  downloadUrl?: string;

  /** Notes de version (optionnel) */
  @Prop({ type: String, default: null })
  releaseNotes?: string;
}

export const AppVersionSchema = SchemaFactory.createForClass(AppVersion);
