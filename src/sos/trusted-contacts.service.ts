import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { getMessaging } from 'firebase-admin/messaging';
import { User, UserDocument } from '../schemas/user.schema';

@Injectable()
export class TrustedContactsService {
  private readonly logger = new Logger(TrustedContactsService.name);

  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
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
      profile: profiles.find((p) => p._id.toString() === c.userId.toString()) || null,
    }));
  }

  /** Invitations reçues en attente de réponse */
  async getPendingInvitations(userId: string) {
    // Chercher les utilisateurs qui ont ce userId dans leurs trustedContacts avec status PENDING
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
      throw new BadRequestException('Vous ne pouvez pas vous ajouter vous-même.');
    }

    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const contact = await this.userModel.findById(contactUserId).lean();
    if (!contact) throw new NotFoundException('Contact introuvable.');

    const current = user.trustedContacts || [];

    // Vérifier la limite de 5
    const accepted = current.filter((c) => c.status === 'ACCEPTED');
    if (accepted.length >= 5) {
      throw new BadRequestException('Vous avez atteint la limite de 5 personnes de confiance.');
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

    return { message: 'Invitation envoyée.', contact: { userId: contactUserId, status: 'PENDING' } };
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
      message: action === 'accept' ? 'Invitation acceptée.' : 'Invitation refusée.',
    };
  }

  /** Retirer un contact de confiance */
  async removeContact(userId: string, contactId: string) {
    await this.userModel.findByIdAndUpdate(userId, {
      $pull: { trustedContacts: { userId: new Types.ObjectId(contactId) } },
    });
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

  private async sendInvitationNotification(inviterPseudo: string, contact: any) {
    const tokens = (contact.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    try {
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
          title: '🤝 Invitation AlertProche',
          body: `${inviterPseudo} souhaite vous ajouter comme Personne de Confiance.`,
        },
        data: { type: 'TRUSTED_CONTACT_INVITE', inviterPseudo },
        android: {
          priority: 'high',
          notification: { channelId: 'alertproche_notifications', sound: 'default' },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });
    } catch (err: any) {
      this.logger.error('Erreur notification invitation :', err?.message);
    }
  }

  private async sendResponseNotification(
    responder: any,
    inviter: any,
    action: 'accept' | 'reject',
  ) {
    const tokens = (inviter.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    const msg = action === 'accept'
      ? `${responder.pseudo} a accepté votre invitation. ✅`
      : `${responder.pseudo} a refusé votre invitation.`;

    try {
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title: 'AlertProche — Réponse à votre invitation', body: msg },
        data: { type: 'TRUSTED_CONTACT_RESPONSE', action, responderPseudo: responder.pseudo },
        android: {
          priority: 'high',
          notification: { channelId: 'alertproche_notifications', sound: 'default' },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });
    } catch (err: any) {
      this.logger.error('Erreur notification réponse :', err?.message);
    }
  }
}
