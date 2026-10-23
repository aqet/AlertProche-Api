import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GeoCacheDocument = GeoCache & Document;

/**
 * Cache de résolution géographique.
 *
 * Une IP n'est jamais stockée en clair : on garde uniquement son empreinte
 * SHA-256 (16 caractères), le pays et la ville résolus. Cela évite d'appeler
 * l'API externe à chaque visite tout en limitant les données personnelles.
 */
@Schema({ timestamps: true })
export class GeoCache {
  @Prop({ required: true, unique: true })
  ipHash: string;

  @Prop()
  country: string;

  @Prop()
  countryCode: string;

  @Prop()
  city: string;

  @Prop({ type: String, enum: ['local', 'api', 'none'], default: 'none' })
  source: string;

  @Prop({ type: Date, default: Date.now })
  resolvedAt: Date;
}

export const GeoCacheSchema = SchemaFactory.createForClass(GeoCache);

GeoCacheSchema.index({ ipHash: 1 }, { unique: true });
// Les résultats sont conservés 180 jours puis oubliés automatiquement.
GeoCacheSchema.index({ resolvedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
