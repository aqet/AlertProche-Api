import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from './schemas/message.schema';
import { User, UserDocument } from '../schemas/user.schema';
import { ModerationService } from '../common/moderation/moderation.service';
import { PushService } from '../common/push/push.service';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const PREVIEW_LENGTH = 100;

/** Rate-limit doux : 15 messages / minute / utilisateur (fenêtre glissante en mémoire) */
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  /** Fenêtres de rate-limit par utilisateur (mémoire d'instance) */
  private readonly sendTimestamps = new Map<string, number[]>();

  constructor(
    @InjectModel(Conversation.name)
    private conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name)
    private messageModel: Model<MessageDocument>,
    @InjectModel(User.name)
    private userModel: Model<UserDocument>,
    private readonly moderation: ModerationService,
    private readonly push: PushService,
  ) {}

  // ── Helpers ─────────────────────────────────────────────────────────

  private pairKeyOf(a: string, b: string): string {
    return [a, b].sort().join('_');
  }

  /** Vérifie que l'utilisateur est bien participant, sinon 403. */
  private async assertParticipant(conversationId: string, userId: string): Promise<ConversationDocument> {
    if (!Types.ObjectId.isValid(conversationId)) {
      throw new NotFoundException('Conversation introuvable.');
    }
    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation introuvable.');

    const isParticipant = conversation.participants.some((p) => p.toString() === userId);
    if (!isParticipant) throw new ForbiddenException('Accès refusé : vous n\'êtes pas participant.');

    return conversation;
  }

  private checkSendRate(userId: string): void {
    const now = Date.now();
    const window = (this.sendTimestamps.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (window.length >= RATE_LIMIT_MAX) {
      throw new HttpException(
        'Trop de messages envoyés. Réessayez dans une minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    window.push(now);
    this.sendTimestamps.set(userId, window);
  }

  private preview(text: string): string {
    const trimmed = text.trim();
    return trimmed.length > PREVIEW_LENGTH ? `${trimmed.slice(0, PREVIEW_LENGTH)}…` : trimmed;
  }

  // ── Conversations ───────────────────────────────────────────────────

  /** Créer (ou récupérer) le fil 1:1 avec un autre utilisateur. */
  async getOrCreateConversation(meId: string, recipientId: string) {
    if (!Types.ObjectId.isValid(recipientId)) {
      throw new BadRequestException('Destinataire invalide.');
    }
    if (recipientId === meId) {
      throw new BadRequestException('Impossible de vous écrire à vous-même.');
    }

    const recipient = await this.userModel
      .findById(recipientId)
      .select('pseudo photoUrl')
      .lean<{ pseudo: string; photoUrl?: string | null }>();
    if (!recipient) throw new NotFoundException('Utilisateur introuvable.');

    const me = await this.userModel
      .findById(meId)
      .select('pseudo photoUrl')
      .lean<{ pseudo: string; photoUrl?: string | null }>();

    const pairKey = this.pairKeyOf(meId, recipientId);
    const existing = await this.conversationModel.findOne({ pairKey });
    if (existing) return this.formatConversation(existing, new Types.ObjectId(meId));

    const conversation = await this.conversationModel.create({
      participants: [meId, recipientId].sort(),
      pairKey,
      lastMessageAt: new Date(),
      lastMessagePreview: '',
      peerSnapshot: { pseudo: recipient.pseudo, photoUrl: recipient.photoUrl ?? null },
    });

    this.logger.log(`💬 Conversation créée : ${pairKey} par ${me?.pseudo ?? meId}`);
    return this.formatConversation(conversation, new Types.ObjectId(meId), {
      pseudo: recipient.pseudo,
      photoUrl: recipient.photoUrl ?? null,
    });
  }

  /**
   * Boîte de réception : conversations de l'utilisateur, triées du plus récent
   * au plus ancien, avec nombre de messages non lus agrégé en une seule requête.
   */
  async listConversations(meId: string) {
    const meObjectId = new Types.ObjectId(meId);

    const conversations = await this.conversationModel
      .find({ participants: meObjectId })
      .sort({ lastMessageAt: -1 })
      .limit(50)
      .lean();

    if (conversations.length === 0) return [];

    const ids = conversations.map((c) => c._id);

    const unreadAgg = await this.messageModel.aggregate([
      {
        $match: {
          conversation: { $in: ids },
          readAt: null,
          sender: { $ne: meObjectId },
        },
      },
      { $group: { _id: '$conversation', count: { $sum: 1 } } },
    ]);
    const unreadMap = new Map<string, number>(
      unreadAgg.map((r) => [r._id.toString(), r.count as number]),
    );

    // Snapshot de l'interlocuteur (pseudo/photo) — depuis les users si absent
    const peerIds = conversations.map((c) => {
      const other = c.participants.find((p: any) => p.toString() !== meId);
      return other as Types.ObjectId;
    });
    const peers = await this.userModel
      .find({ _id: { $in: peerIds } })
      .select('pseudo photoUrl')
      .lean();
    const peerMap = new Map(peers.map((p) => [p._id.toString(), p]));

    return conversations.map((c) => {
      const otherId = c.participants.find((p: any) => p.toString() !== meId)!.toString();
      const peer = peerMap.get(otherId);
      return {
        _id: c._id,
        peer: {
          userId: otherId,
          pseudo: peer?.pseudo ?? c.peerSnapshot?.pseudo ?? '',
          photoUrl: peer?.photoUrl ?? c.peerSnapshot?.photoUrl ?? null,
        },
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        unreadCount: unreadMap.get(c._id.toString()) ?? 0,
      };
    });
  }

  // ── Messages ────────────────────────────────────────────────────────

  /**
   * Récupère les messages d'une conversation.
   * - avec `since` : uniquement les messages plus récents OU modifiés depuis le
   *   curseur (le polling delta renvoie aussi les accusés reçus/lu, qui font
   *   bouger `updatedAt`).
   * - sans `since` : les N derniers messages (chargement initial).
   *
   * L'accusé de réception est posé AVANT la capture de `serverNow` : les bumps
   * d'`updatedAt` qu'il provoque sont alors antérieurs au curseur renvoyé →
   * aucun écho dans les deltas suivants. `serverNow` reste capturé avant la
   * requête → le curseur est conservateur (possibles doublons, jamais de
   * message manqué ; le client remplace par _id).
   */
  async getMessages(meId: string, conversationId: string, since?: string, limit = DEFAULT_PAGE_SIZE) {
    await this.assertParticipant(conversationId, meId);

    // 1. Accusé de réception (tous les messages entrants non encore récupérés)
    await this.markDelivered(meId, conversationId);

    // 2. Curseur de polling
    const pageSize = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
    const serverNow = new Date().toISOString();
    const filter: Record<string, any> = { conversation: conversationId };

    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) throw new BadRequestException('Curseur `since` invalide.');
      filter.$or = [{ createdAt: { $gt: sinceDate } }, { updatedAt: { $gt: sinceDate } }];
      const messages = await this.messageModel.find(filter).sort({ createdAt: 1 }).limit(pageSize).lean();
      return { messages, serverNow };
    }

    const messages = await this.messageModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(pageSize)
      .lean();
    return { messages: messages.reverse(), serverNow };
  }

  /**
   * Accusé de réception : signale que `meId` a récupéré les messages entrants
   * de la conversation. Effectué avant la capture du curseur (voir ci-dessus).
   */
  private async markDelivered(meId: string, conversationId: string): Promise<void> {
    await this.messageModel.updateMany(
      { conversation: conversationId, sender: { $ne: meId }, deliveredAt: null },
      { $set: { deliveredAt: new Date() } },
    );
  }

  /** Envoie un message dans une conversation. */
  async sendMessage(meId: string, conversationId: string, rawText: string) {
    const conversation = await this.assertParticipant(conversationId, meId);

    const text = (rawText ?? '').trim();
    if (!text) throw new BadRequestException('Message vide.');

    // Modération (même dictionnaire que le feed / commentaires)
    this.moderation.validateOrThrow(text);

    this.checkSendRate(meId);

    const message = await this.messageModel.create({
      conversation: conversation._id,
      sender: meId,
      text,
      deliveredAt: null,
      readAt: null,
    });

    await this.conversationModel.updateOne(
      { _id: conversation._id },
      { $set: { lastMessageAt: message.createdAt, lastMessagePreview: this.preview(text) } },
    );

    // Notification push au destinataire (fire-and-forget : ne pas ralentir l'envoi)
    const recipientId = conversation.participants.find((p) => p.toString() !== meId)!.toString();
    const me = await this.userModel.findById(meId).select('pseudo').lean<{ pseudo: string }>();
    void this.push
      .sendToUser(recipientId, {
        title: me?.pseudo ?? 'Nouveau message',
        body: this.preview(text),
        data: { type: 'CHAT_MESSAGE', conversationId: conversation._id.toString() },
      })
      .catch((err) => this.logger.error(`Push message ratée : ${err?.message}`));

    return message;
  }

  /** Marque tous les messages reçus de cette conversation comme lus. */
  async markRead(meId: string, conversationId: string) {
    await this.assertParticipant(conversationId, meId);
    const now = new Date();
    // L'ouverture de la conversation implique aussi la réception :
    // deliveredAt ≤ readAt est toujours respecté (même `now` pour les deux).
    await this.messageModel.updateMany(
      { conversation: conversationId, sender: { $ne: meId }, deliveredAt: null },
      { $set: { deliveredAt: now } },
    );
    const result = await this.messageModel.updateMany(
      { conversation: conversationId, readAt: null, sender: { $ne: meId } },
      { $set: { readAt: now } },
    );
    return { updated: result.modifiedCount };
  }

  /** Total des messages non lus (badge navbar), agrégé en 1 requête. */
  async unreadTotal(meId: string): Promise<{ count: number }> {
    const count = await this.messageModel.countDocuments({
      readAt: null,
      sender: { $ne: new Types.ObjectId(meId) },
      conversation: { $in: await this.conversationModel.distinct('_id', { participants: meId }) },
    });
    return { count };
  }

  // ── Formatage ───────────────────────────────────────────────────────

  private formatConversation(
    conversation: ConversationDocument,
    meObjectId: Types.ObjectId,
    peerFallback?: { pseudo: string; photoUrl: string | null },
  ) {
    const otherId = conversation.participants.find((p) => p.toString() !== meObjectId.toString())!;
    return {
      _id: conversation._id,
      peer: {
        userId: otherId.toString(),
        pseudo: peerFallback?.pseudo ?? conversation.peerSnapshot?.pseudo ?? '',
        photoUrl: peerFallback?.photoUrl ?? conversation.peerSnapshot?.photoUrl ?? null,
      },
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
      unreadCount: 0,
    };
  }
}
