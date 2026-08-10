import { Injectable, Logger } from '@nestjs/common';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';

export interface FcmBatchResult {
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}

@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private readonly BATCH_SIZE = 500;

  /**
   * Envoie une notification push de mise à jour en batch.
   * Nettoie automatiquement les tokens invalides (les retourne pour que
   * l'appelant puisse les supprimer de la base).
   */
  async sendBatchUpdateNotifications(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<FcmBatchResult> {
    const result: FcmBatchResult = { successCount: 0, failureCount: 0, invalidTokens: [] };
    if (tokens.length === 0) return result;

    // Guard Firebase init
    try { getMessaging(); } catch {
      this.logger.error('Firebase Admin non initialisé - sendBatchUpdateNotifications ignoré.');
      return result;
    }

    for (let i = 0; i < tokens.length; i += this.BATCH_SIZE) {
      const batch = tokens.slice(i, i + this.BATCH_SIZE);

      const message: MulticastMessage = {
        tokens: batch,
        notification: { title, body },
        data: { type: 'APP_UPDATE', ...(data || {}) },
        android: {
          priority: 'high',
          notification: {
            channelId: 'alertproche_notifications',
            sound: 'default',
            priority: 'default',
            visibility: 'public',
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
          payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } },
        },
      };

      try {
        const res = await getMessaging().sendEachForMulticast(message);
        result.successCount += res.successCount;
        result.failureCount += res.failureCount;

        res.responses.forEach((r, idx) => {
          if (!r.success) {
            const code = r.error?.code || '';
            if (
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered'
            ) {
              result.invalidTokens.push(batch[idx]);
            }
          }
        });
      } catch (err: any) {
        this.logger.error(`Erreur FCM batch update lot ${i / this.BATCH_SIZE + 1}:`, err?.message);
      }
    }

    this.logger.log(`FCM Update : ${result.successCount} succès / ${result.failureCount} échecs`);
    return result;
  }
}
