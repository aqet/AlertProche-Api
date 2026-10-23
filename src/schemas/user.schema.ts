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

  /* ── Confiance & réputation ──────────────────────────────────────
     Deux axes volontairement séparés :
     - `credibility` : score positif (0-100), public sous forme de badge.
     - `strikes`     : sanctions, PRIVÉES (staff uniquement), jamais publiques
       pour éviter tout harcèlement d'une famille en deuil. */

  /** Score de confiance positif (0-100). */
  @Prop({ default: 0, min: 0, max: 100 })
  credibility: number;

  /** Nombre d'avertissements (fauxes alertes confirmées par le staff). */
  @Prop({ default: 0 })
  strikes: number;

  /** Nombre d'alertes de ce compte cautionnées par la communauté. */
  @Prop({ default: 0 })
  confirmedAlerts: number;

  /** Nombre d'alertes de ce compte effectivement résolues. */
  @Prop({ default: 0 })
  resolvedAlerts: number;

  /**
   * Points de crédibilité déjà gagnés en confirmant les alertes des autres.
   * Sert uniquement à appliquer le plafond (MAX_POINTS_FROM_VOTES) : on peut
   * monter en réputation par la participation, mais pas indéfiniment.
   */
  @Prop({ default: 0 })
  voteCredibilityPoints: number;

  /** Dernière attribution d'un point de participation (1 par jour max). */
  @Prop({ type: Date, default: null })
  lastVotePointAt?: Date | null;

  /** Date du dernier avertissement (affiche un délai d'attente pour l'admin). */
  @Prop({ type: Date, default: null })
  lastStrikeAt?: Date | null;

  /** Historique privé des motifs d'avertissement (staff uniquement). */
  @Prop({ type: [String], default: [] })
  strikeReasons: string[];

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
