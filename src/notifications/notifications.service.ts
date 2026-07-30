import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as admin from 'firebase-admin';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Model } from 'mongoose';
import { Notification , NotificationDocument } from 'src/schemas/notification.schema';

@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    @InjectModel(Notification.name)
    private notificationModel: Model<NotificationDocument>,
  ) {}

  onModuleInit() {
    // ⚠️ Remplace ce chemin par le chemin réel vers ton fichier JSON téléchargé depuis Firebase
    // if (process.env.FIREBASE_PRIVATE_KEY) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Remplacement des sauts de ligne pour la clé privée
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), 
        }),
      });
  }

  async sauvegarderToken(userId: string, token: string) {
    // TODO: Utiliser Mongoose/MongoDB pour sauvegarder ce token
    // Exemple : this.userModel.findByIdAndUpdate(userId, { pushToken: token })
    this.notificationModel.create({
      userId: userId,
      token: token,
    });
    console.log(`Le token ${token} a été associé à l'utilisateur ${userId}`);
    return { status: 'success', message: 'Token enregistré' };
  }

  async envoyerNotification(
    tokenClient: string,
    titre: string,
    message: string,
  ) {
    const payload = {
      notification: {
        title: titre,
        body: message,
      },
      token: tokenClient,
    };

    try {
      const response = await getMessaging().send(payload);
      console.log('Notification envoyée avec succès :', response);
      return { success: true, response };
    } catch (error) {
      console.error("Erreur lors de l'envoi FCM :", error);
      return { success: false, error };
    }
  }
}
