import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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

  // Tableau pour stocker les tokens de tous les appareils de l'utilisateur
  @Prop({ type: [String], default: [] })
  token: string[];
}

export const UserSchema = SchemaFactory.createForClass(User);

// Index pour les recherches rapides
UserSchema.index({ email: 1 });
UserSchema.index({ pseudo: 1 });
