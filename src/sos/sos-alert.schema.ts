import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type SosAlertDocument = SosAlert & Document;

@Schema({ timestamps: true })
export class SosAlert {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId: string;

  // Position GeoJSON — mise à jour par WebSocket toutes les 10 secondes
  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: { type: [Number], required: true }, // [longitude, latitude]
  })
  location: { type: string; coordinates: [number, number] };

  @Prop({
    type: String,
    enum: ['ACTIVE', 'RESOLVED', 'CANCELLED'],
    default: 'ACTIVE',
  })
  status: 'ACTIVE' | 'RESOLVED' | 'CANCELLED';

  // Contacts notifiés (Personnes de Confiance qui ont reçu l'alerte)
  @Prop([{ type: MongooseSchema.Types.ObjectId, ref: 'User' }])
  notifiedContacts: string[];

  // Contacts qui ont confirmé "J'arrive"
  @Prop([{ type: MongooseSchema.Types.ObjectId, ref: 'User' }])
  respondingContacts: string[];

  // Message vocal transcrit par l'IA (optionnel)
  @Prop({ type: String })
  voiceTranscription?: string;

  // Niveau de menace analysé par l'IA : LOW / MEDIUM / HIGH / CRITICAL
  @Prop({ type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  threatLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  // URL du fichier audio original (stocké sur Cloudinary)
  @Prop({ type: String })
  audioUrl?: string;

  // Raison de clôture
  @Prop({ type: String })
  resolvedReason?: string;

  @Prop({ type: Date })
  resolvedAt?: Date;
}

export const SosAlertSchema = SchemaFactory.createForClass(SosAlert);

// Index spatial 2dsphere pour les requêtes de proximité (rayon 500m-1km)
SosAlertSchema.index({ location: '2dsphere' });
// Index pour retrouver rapidement les alertes actives d'un utilisateur
SosAlertSchema.index({ userId: 1, status: 1 });
