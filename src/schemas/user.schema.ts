import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export type UserDocument = User & Document;
export type UserRole = 'Standard' | 'Moderateur' | 'Admin';

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  email: string;

  @Prop({ required: true })
  password: string;

  @Prop({ required: true, unique: true, trim: true })
  pseudo: string;

  @Prop({ type: String, enum: ['Standard', 'Moderateur', 'Admin'], default: 'Standard' })
  role: UserRole;

  @Prop({ required: true, unique: false, trim: true })
  location: string;

  // Photo de profil (URL Cloudinary - utilisée dans les alertes SOS de proximité)
  @Prop({ type: String, default: null })
  photoUrl?: string;

  // PIN 4 chiffres hashé pour clôturer un SOS
  @Prop({ type: String, default: null })
  sosPin?: string;

  // Version de l'application mobile installée (ex: "1.0.0")
  @Prop({ type: String, default: null })
  appVersion?: string;

  // Token FCM principal (single - différent du tableau multi-appareils `token`)
  // ⚠️ On garde le champ `token[]` existant, on ajoute juste `lastUpdateNotificationSentAt`
  @Prop({ type: Date, default: null })
  lastUpdateNotificationSentAt?: Date;

  // Tokens FCM pour les notifications push (multi-appareils)
  @Prop({ type: [String], default: [] })
  token: string[];

  // Personnes de Confiance - max 5
  @Prop({
    type: [
      {
        userId: { type: MongooseSchema.Types.ObjectId, ref: 'User' },
        status: {
          type: String,
          enum: ['PENDING', 'ACCEPTED', 'REJECTED'],
          default: 'PENDING',
        },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
    validate: {
      validator: (v: any[]) => v.length <= 5,
      message: 'Maximum 5 personnes de confiance autorisées.',
    },
  })
  trustedContacts: {
    userId: string;
    status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
    addedAt: Date;
  }[];

  // Opt-out alertes de proximité (true = désactivé, false = activé par défaut)
  @Prop({ type: Boolean, default: false })
  disableProximityAlerts: boolean;

  // Dernière position GPS connue (mise à jour lors des SOS actifs)
  @Prop({
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: [Number], // [longitude, latitude]
    cachedAt: Date,
  })
  lastKnownLocation?: {
    type: string;
    coordinates: [number, number];
    cachedAt: Date;
  };
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ email: 1 });
UserSchema.index({ pseudo: 1 });
UserSchema.index({ lastKnownLocation: '2dsphere' });
