import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
import { SosAlert, SosAlertDocument } from './sos-alert.schema';
import { User, UserDocument } from '../schemas/user.schema';

@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);

  constructor(
    @InjectModel(SosAlert.name) private sosModel: Model<SosAlertDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  // ── DÉCLENCHER UN SOS ───────────────────────────────────────────────────
  async trigger(
    userId: string,
    latitude: number,
    longitude: number,
    voiceTranscription?: string,
    threatLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    audioUrl?: string,
  ): Promise<SosAlertDocument> {
    // Annuler tout SOS actif précédent de cet utilisateur
    await this.sosModel.updateMany(
      { userId: new Types.ObjectId(userId), status: 'ACTIVE' },
      { $set: { status: 'CANCELLED', resolvedAt: new Date() } },
    );

    // Récupérer l'émetteur du SOS
    const user = await this.userModel.findById(userId).lean();
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    // Créer l'alerte SOS
    const sos = await this.sosModel.create({
      userId: new Types.ObjectId(userId),
      location: { type: 'Point', coordinates: [longitude, latitude] },
      status: 'ACTIVE',
      notifiedContacts: [],
      respondingContacts: [],
      voiceTranscription,
      threatLevel: threatLevel || 'MEDIUM',
      audioUrl,
    });

    // Sauvegarder la dernière position connue de l'utilisateur
    await this.userModel.findByIdAndUpdate(userId, {
      lastKnownLocation: {
        type: 'Point',
        coordinates: [longitude, latitude],
        cachedAt: new Date(),
      },
    });

    // Récupérer les contacts de confiance acceptés
    const trustedContacts = (user.trustedContacts || []).filter(
      (c) => c.status === 'ACCEPTED',
    );

    // Envoyer les notifications push
    await this.notifyTrustedContacts(sos, user, trustedContacts);
    await this.notifyNearbyUsers(sos, user, latitude, longitude);

    return sos;
  }

  // ── METTRE À JOUR LA POSITION GPS (WebSocket toutes les 10s) ───────────
  async updateLocation(
    userId: string,
    sosId: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    const sos = await this.sosModel.findOne({
      _id: new Types.ObjectId(sosId),
      userId: new Types.ObjectId(userId),
      status: 'ACTIVE',
    });

    if (!sos) return; // SOS déjà résolu, on ignore silencieusement

    await this.sosModel.findByIdAndUpdate(sosId, {
      location: { type: 'Point', coordinates: [longitude, latitude] },
    });

    // Mettre aussi à jour le cache de dernière position
    await this.userModel.findByIdAndUpdate(userId, {
      lastKnownLocation: {
        type: 'Point',
        coordinates: [longitude, latitude],
        cachedAt: new Date(),
      },
    });
  }

  // ── ANNULER UN SOS (émetteur) ─────────────────────────────────────────
  async cancel(
    userId: string,
    sosId: string,
    reason?: string,
  ): Promise<{ message: string }> {
    const sos = await this.sosModel.findOne({
      _id: new Types.ObjectId(sosId),
      userId: new Types.ObjectId(userId),
      status: 'ACTIVE',
    });

    if (!sos) throw new NotFoundException('Alerte SOS active introuvable.');

    await this.sosModel.findByIdAndUpdate(sosId, {
      status: 'CANCELLED',
      resolvedReason: reason || "Annulé par l'utilisateur",
      resolvedAt: new Date(),
    });

    // Notifier les contacts que l'alerte est annulée
    await this.notifyResolution(sos, 'CANCELLED', userId);

    return { message: 'Alerte SOS annulée avec succès.' };
  }

  // ── RÉSOUDRE UN SOS (personne de confiance ou auto-clôture) ───────────
  async resolve(
    requesterId: string,
    sosId: string,
    reason?: string,
  ): Promise<{ message: string }> {
    const sos = await this.sosModel.findById(sosId);
    if (!sos || sos.status !== 'ACTIVE')
      throw new NotFoundException('Alerte SOS active introuvable.');

    // Vérifier que le demandeur est l'émetteur OU une personne de confiance acceptée
    const user = await this.userModel.findById(sos.userId).lean();
    const isTrusted = (user?.trustedContacts || []).some(
      (c) => c.userId.toString() === requesterId && c.status === 'ACCEPTED',
    );
    const isOwner = sos.userId.toString() === requesterId;

    if (!isOwner && !isTrusted) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à clôturer cette alerte.",
      );
    }

    await this.sosModel.findByIdAndUpdate(sosId, {
      status: 'RESOLVED',
      resolvedReason: reason || 'Marqué comme résolu',
      resolvedAt: new Date(),
    });

    await this.notifyResolution(sos, 'RESOLVED', requesterId);

    return { message: 'Alerte SOS résolue avec succès.' };
  }

  // ── CONFIRMER "J'ARRIVE" (personne de confiance) ──────────────────────
  async confirmResponse(
    contactId: string,
    sosId: string,
  ): Promise<{ message: string }> {
    const sos = await this.sosModel.findOne({
      _id: new Types.ObjectId(sosId),
      status: 'ACTIVE',
    });
    if (!sos)
      throw new NotFoundException('Alerte SOS introuvable ou déjà clôturée.');

    await this.sosModel.findByIdAndUpdate(sosId, {
      $addToSet: { respondingContacts: new Types.ObjectId(contactId) },
    });

    // Retourner le nombre de personnes en route (pour le WebSocket côté émetteur)
    const updated = await this.sosModel.findById(sosId).lean();
    return {
      message: 'Confirmation enregistrée.',
    };
  }

  // ── STATUT D'UN SOS (polling côté émetteur + page contact) ──────────────
  async getSosStatus(requesterId: string, sosId: string): Promise<any> {
    const sos = await this.sosModel.findById(sosId).lean();
    if (!sos) throw new NotFoundException('SOS introuvable.');

    // Vérifier que le demandeur est l'émetteur OU une personne de confiance notifiée
    const isOwner = sos.userId.toString() === requesterId;
    const isNotified = (sos.notifiedContacts || []).some(
      (id) => id.toString() === requesterId,
    );

    if (!isOwner && !isNotified) {
      throw new ForbiddenException('Accès non autorisé à cette alerte.');
    }

    // Récupérer le profil de l'émetteur
    const emitter = await this.userModel
      .findById(sos.userId)
      .select('pseudo photoUrl')
      .lean();

    // Récupérer les profils des personnes en route
    const respondingIds = (sos.respondingContacts || []).map((id) =>
      id.toString(),
    );
    const respondingProfiles = await this.userModel
      .find({ _id: { $in: respondingIds } })
      .select('pseudo photoUrl')
      .lean();

    const [lng, lat] = sos.location.coordinates;

    return {
      _id: sos._id,
      status: sos.status,
      threatLevel: sos.threatLevel,
      voiceTranscription: sos.voiceTranscription,
      latitude: lat,
      longitude: lng,
      createdAt: (sos as any).createdAt,
      resolvedAt: sos.resolvedAt,
      resolvedReason: sos.resolvedReason,
      emitter: emitter || null,
      respondingCount: respondingIds.length,
      respondingContacts: respondingProfiles,
      isOwner,
    };
  }

  // ── HISTORIQUE SOS COMPLET — 3 catégories ────────────────────────────
  async getFullHistory(userId: string): Promise<any> {
    const uid = new Types.ObjectId(userId);

    // 1. SOS émis par cet utilisateur
    const emitted = await this.sosModel
      .find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // 2. SOS auxquels l'utilisateur a répondu ("J'arrive")
    const responded = await this.sosModel
      .find({
        respondingContacts: uid,
        userId: { $ne: uid }, // exclure ses propres SOS
      })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // 3. SOS reçus (notifié) mais où il n'a pas répondu (alertes de proximité ou contacts)
    const received = await this.sosModel
      .find({
        notifiedContacts: uid,
        respondingContacts: { $ne: uid }, // pas encore en route
        userId: { $ne: uid },
      })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // Enrichir chaque SOS avec le profil de l'émetteur
    const enrichSos = async (list: any[], role: string) => {
      return Promise.all(
        list.map(async (sos) => {
          const emitter = await this.userModel
            .findById(sos.userId)
            .select('pseudo photoUrl')
            .lean();
          const [lng, lat] = sos.location.coordinates;
          return {
            _id: sos._id,
            status: sos.status,
            threatLevel: sos.threatLevel,
            latitude: lat,
            longitude: lng,
            createdAt: sos.createdAt,
            resolvedAt: sos.resolvedAt,
            resolvedReason: sos.resolvedReason,
            respondingCount: (sos.respondingContacts || []).length,
            notifiedCount: (sos.notifiedContacts || []).length,
            emitter: emitter || null,
            role, // 'emitted' | 'responded' | 'received'
          };
        }),
      );
    };

    const [emittedEnriched, respondedEnriched, receivedEnriched] =
      await Promise.all([
        enrichSos(emitted, 'emitted'),
        enrichSos(responded, 'responded'),
        enrichSos(received, 'received'),
      ]);

    return {
      emitted: emittedEnriched,
      responded: respondedEnriched,
      received: receivedEnriched,
      total:
        emittedEnriched.length +
        respondedEnriched.length +
        receivedEnriched.length,
    };
  }

  // ── HISTORIQUE SOS D'UN UTILISATEUR (legacy) ──────────────────────────
  async getHistory(userId: string): Promise<SosAlertDocument[]> {
    return this.sosModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean() as any;
  }

  // ── SOS ACTIF D'UN UTILISATEUR ────────────────────────────────────────
  async getActiveSos(userId: string): Promise<SosAlertDocument | null> {
    return this.sosModel
      .findOne({
        userId: new Types.ObjectId(userId),
        status: 'ACTIVE',
      })
      .lean() as any;
  }

  // ── AUTO-CLÔTURE APRÈS 12H (appelé par un cron job) ───────────────────
  async autoCloseExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const expired = await this.sosModel.find({
      status: 'ACTIVE',
      createdAt: { $lt: cutoff },
    });

    for (const sos of expired) {
      await this.sosModel.findByIdAndUpdate(sos._id, {
        status: 'RESOLVED',
        resolvedReason: "Auto-clôturé après 12h d'inactivité",
        resolvedAt: new Date(),
      });
      this.logger.warn(`SOS ${sos._id} auto-clôturé après 12h.`);
    }
  }

  // ── ALERTE BATTERIE CRITIQUE ───────────────────────────────────────────
  async handleLowBattery(userId: string, sosId: string): Promise<void> {
    const sos = await this.sosModel
      .findOne({
        _id: new Types.ObjectId(sosId),
        userId: new Types.ObjectId(userId),
        status: 'ACTIVE',
      })
      .lean();
    if (!sos) return;

    const user = await this.userModel.findById(userId).lean();
    const trustedContacts = await this.getTrustedContactUsers(user);
    const tokens = trustedContacts
      .flatMap((c) => c.token || [])
      .filter(Boolean);

    if (tokens.length === 0) return;

    const [lng, lat] = sos.location.coordinates;
    await this.sendFcm(tokens, {
      title: '🔴 Batterie critique — AlertProche',
      body: `La batterie de ${user.pseudo} est presque vide. Dernière position : ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      data: {
        sosId: sos._id.toString(),
        type: 'LOW_BATTERY',
        lat: String(lat),
        lng: String(lng),
      },
    });
  }

  // ── NOTIFICATIONS INTERNES ─────────────────────────────────────────────

  private async notifyTrustedContacts(
    sos: SosAlertDocument,
    emitter: any,
    trustedContacts: any[],
  ): Promise<void> {
    if (trustedContacts.length === 0) return;

    const contactIds = trustedContacts.map((c) => c.userId.toString());
    const contactUsers = await this.userModel
      .find({ _id: { $in: contactIds } })
      .lean();

    const tokens = contactUsers.flatMap((u) => u.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    const [lng, lat] = sos.location.coordinates;
    const bodyText = sos.voiceTranscription
      ? `"${sos.voiceTranscription.slice(0, 100)}" — ${lat.toFixed(4)}, ${lng.toFixed(4)}`
      : `Position : ${lat.toFixed(4)}, ${lng.toFixed(4)}`;

    await this.sendFcm(tokens, {
      title: `🆘 SOS — ${emitter.pseudo} a besoin d'aide !`,
      body: bodyText,
      data: {
        sosId: sos._id.toString(),
        type: 'SOS_TRUSTED',
        lat: String(lat),
        lng: String(lng),
        emitterName: emitter.pseudo,
        photoUrl: emitter.photoUrl || '',
        threatLevel: sos.threatLevel || 'MEDIUM',
      },
    });

    // Enregistrer les contacts notifiés
    await this.sosModel.findByIdAndUpdate(sos._id, {
      $addToSet: {
        notifiedContacts: {
          $each: contactIds.map((id) => new Types.ObjectId(id)),
        },
      },
    });
  }

  private async notifyNearbyUsers(
    sos: SosAlertDocument,
    emitter: any,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    // Chercher les utilisateurs dans un rayon de 1km qui ont les alertes de proximité activées
    const nearbyUsers = await this.userModel
      .find({
        _id: { $ne: new Types.ObjectId(emitter._id.toString()) },
        disableProximityAlerts: { $ne: true },
        lastKnownLocation: {
          $near: {
            $geometry: { type: 'Point', coordinates: [longitude, latitude] },
            $maxDistance: 1000, // 1km
          },
        },
      })
      .lean();

    const tokens = nearbyUsers.flatMap((u) => u.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    await this.sendFcm(tokens, {
      title: '🆘 Alerte de proximité — AlertProche',
      body: `${emitter.pseudo} a besoin d'aide près de vous !`,
      data: {
        sosId: sos._id.toString(),
        type: 'SOS_PROXIMITY',
        lat: String(latitude),
        lng: String(longitude),
        emitterName: emitter.pseudo,
        photoUrl: emitter.photoUrl || '',
      },
    });
  }

  private async notifyResolution(
    sos: SosAlertDocument,
    status: 'RESOLVED' | 'CANCELLED',
    resolverId: string,
  ): Promise<void> {
    const emitter = await this.userModel.findById(sos.userId).lean();
    const contactIds = (sos.notifiedContacts || []).map((id) => id.toString());
    const contacts = await this.userModel
      .find({ _id: { $in: contactIds } })
      .lean();
    const tokens = contacts.flatMap((u) => u.token || []).filter(Boolean);
    if (tokens.length === 0) return;

    const msg =
      status === 'RESOLVED'
        ? `${emitter?.pseudo} est en sécurité. Alerte clôturée.`
        : `${emitter?.pseudo} a annulé son alerte SOS.`;

    await this.sendFcm(tokens, {
      title: status === 'RESOLVED' ? '✅ Alerte résolue' : '🔕 Alerte annulée',
      body: msg,
      data: { sosId: sos._id.toString(), type: 'SOS_RESOLVED', status },
    });
  }

  private async getTrustedContactUsers(user: any): Promise<any[]> {
    const acceptedIds = (user?.trustedContacts || [])
      .filter((c: any) => c.status === 'ACCEPTED')
      .map((c: any) => c.userId.toString());
    return this.userModel.find({ _id: { $in: acceptedIds } }).lean();
  }

  // ── HELPER FCM ─────────────────────────────────────────────────────────
  private async sendFcm(
    tokens: string[],
    payload: { title: string; body: string; data?: Record<string, string> },
  ): Promise<void> {
    if (tokens.length === 0) return;

    // Guard : Firebase doit être initialisé
    try {
      getMessaging(); // Lance une erreur si Firebase n'est pas init
    } catch {
      this.logger.error('Firebase Admin non initialisé — notifications SOS ignorées.');
      return;
    }

    const BATCH = 500;
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const message: MulticastMessage = {
        tokens: batch,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
        android: {
          priority: 'high' as const,
          notification: {
            channelId: 'alertproche_sos_channel', // Nouveau canal spécifique aux SOS
            sound: 'alertsos', // Nom du fichier dans res/raw (SANS .mp3)
            priority: 'max' as const, // Affichage Heads-Up immédiat
            visibility: 'public' as const, // Visible sur l'écran verrouillé
            defaultSound: false, // IMPORTANT : Désactiver le son système
            defaultVibrateTimings: false, // Personnaliser ou laisser la vibration
            vibrateTimingsMillis: [0, 500, 200, 500, 200, 1000], // Motifs de vibration d'urgence
            notificationCount: 1,
          },
        },
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
          payload: {
            aps: { sound: 'alertsos', badge: 1, 'content-available': 1 },
          },
        },
      };

      try {
        const response = await getMessaging().sendEachForMulticast(message);
        this.logger.log(
          `FCM SOS : ${response.successCount} succès / ${response.failureCount} échecs`,
        );
      } catch (err: any) {
        this.logger.error('Erreur FCM SOS :', err?.message);
      }
    }
  }
}
