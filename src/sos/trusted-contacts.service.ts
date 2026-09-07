import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { getMessaging } from 'firebase-admin/messaging';
import { User, UserDocument } from '../schemas/user.schema';
import { WebPushService } from '../notifications/web-push.service';

@Injectable()
export class TrustedContactsService {
  private readonly logger = new Logger(TrustedContactsService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private readonly webPush: WebPushService,
  ) {}

  /** Récupérer mes personnes de confiance avec leur profil */
  async getMyContacts(userId: string) {
    const user = await this.userModel.findById(userId).lean();
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const contacts = user.trustedContacts || [];
    const ids = contacts.map((c) => c.userId.toString());
    const profiles = await this.userModel
      .find({ _id: { $in: ids } })
      .select('pseudo photoUrl email')
      .lean();

    return contacts.map((c) => ({
      userId: c.userId,
      status: c.status,
      addedAt: c.addedAt,
      profile:
        profiles.find((p) => p._id.toString() === c.userId.toString()) || null,
    }));
  }

  /** Invitations reçues en attente de réponse */
  async getPendingInvitations(userId: string) {
    const inviters = await this.userModel
      .find({
        'trustedContacts.userId': new Types.ObjectId(userId),
        'trustedContacts.status': 'PENDING',
      })
      .select('pseudo photoUrl trustedContacts')
      .lean();

    return inviters.map((u) => ({
      inviterId: u._id,
      pseudo: u.pseudo,
      photoUrl: u.photoUrl,
    }));
  }

  /** Ajouter une personne de confiance (max 5) */
  async addContact(userId: string, contactUserId: string) {
    if (userId === contactUserId) {
      throw new BadRequestException(
        'Vous ne pouvez pas vous ajouter vous-même.',
      );
    }

    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const contact = await this.userModel.findById(contactUserId).lean();
    if (!contact) throw new NotFoundException('Contact introuvable.');

    const current = user.trustedContacts || [];

    // Vérifier la limite de 5
    const accepted = current.filter((c) => c.status === 'ACCEPTED');
    if (accepted.length >= 5) {
      throw new BadRequestException(
        'Vous avez atteint la limite de 5 personnes de confiance.',
      );
    }

    // Vérifier doublon
    const exists = current.find((c) => c.userId.toString() === contactUserId);
    if (exists) {
      throw new BadRequestException('Ce contact est déjà dans votre liste.');
    }

    // Ajouter avec statut PENDING
    user.trustedContacts.push({
      userId: contactUserId as any,
      status: 'PENDING',
      addedAt: new Date(),
    });
    await user.save();

    // Envoyer une notification push d'invitation au contact
    await this.sendInvitationNotification(user.pseudo, contact);

    return {
      message: 'Invitation envoyée.',
      contact: { userId: contactUserId, status: 'PENDING' },
    };
  }

  /** Accepter ou refuser une invitation */
  async respondToInvitation(
    userId: string,
    inviterId: string,
    action: 'accept' | 'reject',
  ) {
    const inviter = await this.userModel.findById(inviterId);
    if (!inviter) throw new NotFoundException('Invitant introuvable.');

    const entry = inviter.trustedContacts.find(
      (c) => c.userId.toString() === userId && c.status === 'PENDING',
    );
    if (!entry) throw new NotFoundException('Invitation introuvable.');

    entry.status = action === 'accept' ? 'ACCEPTED' : 'REJECTED';
    await inviter.save();

    // Notifier l'invitant de la réponse
    const responder = await this.userModel.findById(userId).lean();
    await this.sendResponseNotification(responder, inviter, action);

    return {
      message:
        action === 'accept' ? 'Invitation acceptée.' : 'Invitation refusée.',
    };
  }

  /** Retirer un contact de confiance */
  async removeContact(userId: string, contactId: string) {
    await this.userModel.findByIdAndUpdate(userId, {
      $pull: { trustedContacts: { userId: new Types.ObjectId(contactId) } },
    });
    return { message: 'Contact retiré.' };
  }

  /**
   * Se retirer soi-même de la liste d'un autre utilisateur.
   * ownerId = A (celui dont on veut quitter la liste)
   * selfId  = B (l'appelant - celui qui se retire)
   */
  async leaveTrustedList(selfId: string, ownerId: string) {
    const owner = await this.userModel.findById(ownerId);
    if (!owner) throw new NotFoundException('Utilisateur introuvable.');

    const entry = owner.trustedContacts?.find(
      (c) => c.userId.toString() === selfId,
    );
    if (!entry) throw new NotFoundException('Vous n\'êtes pas dans la liste de cet utilisateur.');

    await this.userModel.findByIdAndUpdate(ownerId, {
      $pull: { trustedContacts: { userId: new Types.ObjectId(selfId) } },
    });

    // Notifier A que B s'est retiré
    const self = await this.userModel.findById(selfId).select('pseudo token').lean();
    if (self) {
      const ownerTokens = (owner.token || []).filter(Boolean);
      if (ownerTokens.length > 0) {
        await this.sendNotifications(ownerTokens, {
          title: 'AlertProche - Contact retiré',
          body: `${self.pseudo} ne fait plus partie de vos contacts de confiance.`,
          data: { type: 'TRUSTED_CONTACT_LEFT', pseudo: self.pseudo },
        });
      }
    }

    return { message: `Vous avez quitté la liste de contacts de confiance de ${owner.pseudo}.` };
  }

  /** Utilisateurs qui m'ont ajouté comme personne de confiance (ACCEPTED) */
  async getWhoTrustedMe(userId: string) {
    const users = await this.userModel
      .find({
        'trustedContacts.userId': new Types.ObjectId(userId),
        'trustedContacts.status': 'ACCEPTED',
      })
      .select('_id pseudo photoUrl')
      .lean();

    return users.map((u) => ({
      userId: u._id,
      pseudo: u.pseudo,
      photoUrl: (u as any).photoUrl || null,
    }));
  }

  // ── Notifications ──────────────────────────────────────────────────────

  private async sendInvitationNotification(
    inviterPseudo: string,
    contact: any,
  ): Promise<void> {
    const tokens = (contact.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    await this.sendNotifications(tokens, {
      title: '🤝 Invitation AlertProche',
      body: `${inviterPseudo} souhaite vous ajouter comme Personne de Confiance.`,
      data: { type: 'TRUSTED_CONTACT_INVITE', inviterPseudo },
    });
  }

  private async sendResponseNotification(
    responder: any,
    inviter: any,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const tokens = (inviter.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    const body =
      action === 'accept'
        ? `${responder.pseudo} a accepté votre invitation. ✅`
        : `${responder.pseudo} a refusé votre invitation.`;

    await this.sendNotifications(tokens, {
      title: 'AlertProche - Réponse à votre invitation',
      body,
      data: {
        type: 'TRUSTED_CONTACT_RESPONSE',
        action,
        responderPseudo: responder.pseudo,
      },
    });
  }

  /**
   * Helper unifié : envoie aux tokens Web Push (PWA) ET FCM (natif).
   * Identique à la logique de SosService.sendNotifications().
   */
  private async sendNotifications(
    tokens: string[],
    payload: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void> {
    if (tokens.length === 0) return;

    const fcmTokens: string[] = [];
    const webPushTokens: string[] = [];

    for (const token of tokens) {
      if (WebPushService.isWebPushToken(token)) {
        webPushTokens.push(token);
      } else {
        fcmTokens.push(token);
      }
    }

    // ── Web Push (PWA) ────────────────────────────────────────────────────
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

    // Supprimer les subscriptions Web Push expirées
    if (expiredWebPush.length > 0) {
      await this.userModel.updateMany(
        { token: { $in: expiredWebPush } },
        { $pull: { token: { $in: expiredWebPush } } },
      );
      this.logger.log(`🗑 ${expiredWebPush.length} subscription(s) Web Push expirée(s) supprimée(s).`);
    }

    // ── FCM (Android natif) ───────────────────────────────────────────────
    if (fcmTokens.length === 0) return;

    try {
      getMessaging();
    } catch {
      this.logger.error('Firebase Admin non initialisé - notifications FCM ignorées.');
      return;
    }

    try {
      const response = await getMessaging().sendEachForMulticast({
        tokens: fcmTokens,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
        android: {
          priority: 'high',
          notification: { channelId: 'alertproche_notifications', sound: 'default' },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });

      // Nettoyer les tokens FCM invalides
      const invalidFcm: string[] = [];
      response.responses.forEach((res, idx) => {
        if (!res.success) {
          const code = res.error?.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) {
            invalidFcm.push(fcmTokens[idx]);
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

      this.logger.log(`FCM contacts: ${response.successCount} succès / ${response.failureCount} échecs`);
    } catch (err: any) {
      this.logger.error('Erreur FCM TrustedContacts:', err?.message);
    }
  }
}
