import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';

/**
 * Service Web Push PWA (protocole W3C Web Push).
 * Utilisé pour envoyer des notifications aux navigateurs web et PWA installées.
 *
 * Configuration VAPID requise dans les variables d'environnement :
 *   VAPID_PUBLIC_KEY  — Clé publique VAPID (partagée avec le frontend)
 *   VAPID_PRIVATE_KEY — Clé privée VAPID (strictement backend)
 *   VAPID_SUBJECT     — URL ou mailto: du propriétaire du serveur
 *
 * Générer les clés : npx web-push generate-vapid-keys
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private initialized = false;

  constructor() {
    this.setup();
  }

  private setup(): void {
    const publicKey  = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject    = process.env.VAPID_SUBJECT || 'mailto:contact@alertproche.com';

    if (!publicKey || !privateKey) {
      this.logger.warn('VAPID_PUBLIC_KEY ou VAPID_PRIVATE_KEY manquant — Web Push désactivé.');
      return;
    }

    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.initialized = true;
    this.logger.log('✅ Web Push (VAPID) initialisé.');
  }

  /**
   * Envoie une notification Web Push à une subscription.
   * @param subscriptionJson  La PushSubscription sérialisée en JSON string
   * @param payload           Objet notification + data
   * @returns true si envoyé, false si erreur ou subscription expirée
   */
  async sendNotification(
    subscriptionJson: string,
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
      requireInteraction?: boolean;
      vibrate?: number[];
    },
  ): Promise<boolean> {
    if (!this.initialized) return false;

    let subscription: webpush.PushSubscription;
    try {
      subscription = JSON.parse(subscriptionJson) as webpush.PushSubscription;
      if (!subscription.endpoint) return false;
    } catch {
      return false;
    }

    const notificationPayload = JSON.stringify({
      notification: {
        title: payload.title,
        body: payload.body,
        icon: '/icons/web-app-manifest-192x192.png',
        badge: '/icons/favicon-96x96.png',
        requireInteraction: payload.requireInteraction ?? false,
        vibrate: payload.vibrate ?? [200, 100, 200],
        data: {
          ...payload.data || {},
          soundUrl: payload.data?.type?.startsWith('SOS') ? '/sounds/sos-alert.mp3' : null,
        },
        actions: payload.data?.type?.startsWith('SOS') ? [
          { action: 'respond', title: "J'arrive" },
          { action: 'dismiss', title: 'Ignorer' },
        ] : [],
      },
      data: {
        ...payload.data || {},
        soundUrl: payload.data?.type?.startsWith('SOS') ? '/sounds/sos-alert.mp3' : null,
      },
    });

    try {
      await webpush.sendNotification(subscription, notificationPayload);
      return true;
    } catch (err: any) {
      // 410 Gone = subscription expirée/révoquée — à supprimer de la DB
      if (err.statusCode === 410 || err.statusCode === 404) {
        this.logger.warn(`Subscription expirée (${err.statusCode}): ${subscription.endpoint.slice(-30)}`);
        return false; // Le caller supprimera ce token
      }
      this.logger.error(`Erreur Web Push: ${err?.message}`);
      return false;
    }
  }

  /** Vérifie si une string est une PushSubscription JSON valide */
  static isWebPushToken(token: string): boolean {
    try {
      const parsed = JSON.parse(token);
      return typeof parsed === 'object' && typeof parsed.endpoint === 'string';
    } catch {
      return false;
    }
  }
}
