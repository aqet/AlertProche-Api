import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
import { User, UserDocument } from '../../schemas/user.schema';
import { WebPushService } from '../../notifications/web-push.service';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Helper d'envoi de notifications push unifié (Web Push PWA + FCM natif).
 * Même logique que le helper privé de SosService, mais partagé :
 * on l'utilise pour les messages directs sans toucher au module SOS.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly BATCH_SIZE = 500;

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly webPush: WebPushService,
  ) {}

  /** Envoie une push à tous les appareils d'un utilisateur. */
  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    const user = await this.userModel
      .findById(userId)
      .select('token')
      .lean<{ token?: string[] }>();
    const tokens = user?.token ?? [];
    if (tokens.length === 0) return;

    const fcmTokens: string[] = [];
    const webPushTokens: string[] = [];
    for (const token of tokens) {
      if (WebPushService.isWebPushToken(token)) webPushTokens.push(token);
      else fcmTokens.push(token);
    }

    // ── Web Push (PWA) ──
    const expiredWebPush: string[] = [];
    await Promise.all(
      webPushTokens.map(async (token) => {
        const sent = await this.webPush.sendNotification(token, {
          title: payload.title,
          body: payload.body,
          data: payload.data,
          requireInteraction: false,
          vibrate: [200, 100, 200],
        });
        if (!sent) expiredWebPush.push(token);
      }),
    );
    if (expiredWebPush.length > 0) {
      await this.userModel.updateMany(
        { token: { $in: expiredWebPush } },
        { $pull: { token: { $in: expiredWebPush } } },
      );
      this.logger.log(`🗑 ${expiredWebPush.length} subscription(s) Web Push expirée(s) supprimée(s).`);
    }

    // ── FCM (apps natives) ──
    if (fcmTokens.length === 0) return;
    try {
      getMessaging();
    } catch {
      this.logger.error('Firebase Admin non initialisé - notifications FCM ignorées.');
      return;
    }

    for (let i = 0; i < fcmTokens.length; i += this.BATCH_SIZE) {
      const batch = fcmTokens.slice(i, i + this.BATCH_SIZE);
      const message: MulticastMessage = {
        tokens: batch,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'alertproche_notifications',
            sound: 'default',
            priority: 'high' as const,
            visibility: 'public' as const,
            defaultSound: true,
            defaultVibrateTimings: true,
            notificationCount: 1,
          },
        },
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
          payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } },
        },
      };

      try {
        const response = await getMessaging().sendEachForMulticast(message);
        this.logger.log(`FCM : ${response.successCount} succès / ${response.failureCount} échecs`);

        const invalidFcm: string[] = [];
        response.responses.forEach((res, idx) => {
          if (!res.success) {
            const code = res.error?.code || '';
            if (
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered'
            ) {
              invalidFcm.push(batch[idx]);
            }
          }
        });
        if (invalidFcm.length > 0) {
          await this.userModel.updateMany(
            { token: { $in: invalidFcm } },
            { $pull: { token: { $in: invalidFcm } } },
          );
          this.logger.log(`🗑 ${invalidFcm.length} token(s) FCM invalide(s) supprimé(s).`);
        }
      } catch (err: any) {
        this.logger.error('Erreur FCM :', err?.message);
      }
    }
  }
}
