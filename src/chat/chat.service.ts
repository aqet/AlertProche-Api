import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ChatSession, ChatSessionDocument } from './schemas/chat-session.schema';
import { ChatStats, ChatStatsDocument } from './schemas/chat-stats.schema';
import { SendMessageDto } from './dto/send-message.dto';
import { AiService } from '../ai/ai.service';

export interface ChatResponse {
  text: string;
  action?: { type: 'direct_redirect' | 'attach_link'; route: string };
}

// Rate limiter simple en mémoire (10 req/min par userId)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT    = 10;
const RATE_WINDOW   = 60 * 1000; // 1 minute

const SYSTEM_PROMPT = `Tu es l'assistant virtuel officiel de l'application citoyenne de sécurité AlertProche (déployée à l'international).

MISSION PRINCIPALE :
Accompagner l'utilisateur, répondre aux questions d'utilisation et faciliter la navigation au sein de l'application.

RÈGLES D'URGENCE ET DE SÉCURITÉ :
1. Détection d'Urgence Immédiate :
- Si l'utilisateur signale une situation de danger imminent ou de détresse (ex: "au secours", "on m'attaque", "besoin d'aide urgente") :
- Donne une réponse très courte lui indiquant d'appuyer immédiatement sur le bouton rouge SOS situé en bas à droite de son écran.
- Invite-le à contacter sans délai les services d'urgence locaux de son pays.
- Ne cherche pas à prolonger la conversation textuelle.
2. Cadre et Limites :
- Tu ne fournis aucun conseil médical, juridique ou de maintien de l'ordre.
- Tu ne dois jamais faire référence à des fonctionnalités, pages ou routes réservées aux administrateurs, sauf si le rôle fourni est 'Admin'.

NAVIGATION ET TOOL CALLING :
Quand l'utilisateur demande explicitement à naviguer quelque part, inclus dans ta réponse un bloc JSON spécial sur UNE SEULE LIGNE à la fin :
{"__action__":"direct_redirect","route":"/la-route"}

Quand l'utilisateur demande où se trouve quelque chose, donne une réponse textuelle et inclus :
{"__action__":"attach_link","route":"/la-route"}

Routes disponibles selon le rôle (RÔLE_UTILISATEUR sera injecté) :
- Tous : /, /feed, /auth, /a-propos, /avis
- Authentifié : /dashboard, /posts/new, /sos/history
- Admin seulement : /admin, /admin/analytics, /moderation

STYLE ET FORMAT :
- Ton rassurant, bienveillant et synthétique.
- Réponses courtes (3 à 4 phrases max) adaptées à un composant de chat sur mobile.`;

const SLIDING_WINDOW = 10; // nb de messages max envoyés au modèle

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectModel(ChatSession.name) private sessionModel:  Model<ChatSessionDocument>,
    @InjectModel(ChatStats.name)   private statsModel:    Model<ChatStatsDocument>,
    private readonly aiService: AiService,
  ) {}

  /** Incrémente le document singleton de stats (upsert) */
  private async incrementStats(fields: Partial<Record<
    'totalAuthSessions' | 'totalGuestSessions' | 'totalAuthMessages' | 'totalGuestMessages',
    number
  >>): Promise<void> {
    const inc: any = {};
    for (const [k, v] of Object.entries(fields)) {
      inc[k] = v;
    }
    await this.statsModel.findOneAndUpdate(
      { key: 'global' },
      { $inc: inc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  /** Récupérer l'historique d'une session (au chargement de la page) */
  async getHistory(userId: string, threadId: string): Promise<{ messages: any[] }> {
    const session = await this.sessionModel.findOne({
      userId:   new Types.ObjectId(userId),
      threadId,
    }).lean();

    // Compter comme nouvelle session si elle n'existe pas encore
    if (!session) {
      this.incrementStats({ totalAuthSessions: 1 }).catch(() => {});
    }

    if (!session) return { messages: [] };

    return {
      messages: session.messages.map(m => ({
        role:      m.role,
        text:      m.content,
        timestamp: m.timestamp,
      })),
    };
  }

  /** Message visiteur non connecté — pas de stockage en base, rate limit par IP */
  async sendGuestMessage(ip: string, dto: SendMessageDto): Promise<ChatResponse> {
    // Rate limit par IP (5 req/min pour les visiteurs)
    const key   = `guest:${ip}`;
    const now   = Date.now();
    const entry = rateLimitMap.get(key);
    if (entry && now < entry.resetAt) {
      if (entry.count >= 5) {
        throw new HttpException('Trop de messages. Attendez une minute.', HttpStatus.TOO_MANY_REQUESTS);
      }
      // Nouvelle session invité : premier message de ce threadId
      const isNewSession = entry.count === 0;
      entry.count++;
      if (isNewSession) {
        this.incrementStats({ totalGuestSessions: 1 }).catch(() => {});
      }
    } else {
      // Premier message de cette IP dans la fenêtre → nouvelle session
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW });
      this.incrementStats({ totalGuestSessions: 1 }).catch(() => {});
    }

    // Incrémenter le compteur de messages invités
    this.incrementStats({ totalGuestMessages: 1 }).catch(() => {});

    // Pas d'historique pour les visiteurs — contexte vide
    const contents = [{ role: 'user', parts: [{ text: dto.message }] }];

    const systemGuest = SYSTEM_PROMPT.replace(
      'RÔLE_UTILISATEUR sera injecté',
      'L\'utilisateur est un visiteur non connecté. Propose-lui de se connecter pour accéder aux fonctionnalités complètes.',
    );

    const geminiResponse = await this.aiService.generateChatResponse(contents, systemGuest);
    const rawResponse = geminiResponse || 'Je suis temporairement indisponible.';

    let action: ChatResponse['action'] | undefined;
    let text = rawResponse;

    const actionMatch = rawResponse.match(/\{[^}]*"__action__"[^}]*\}/);
    if (actionMatch) {
      try {
        const parsed = JSON.parse(actionMatch[0]);
        if (parsed.__action__ && parsed.route) {
          // Visiteurs : seulement les routes publiques
          const publicRoutes = ['/', '/feed', '/auth', '/a-propos', '/avis'];
          if (publicRoutes.includes(parsed.route)) {
            action = { type: parsed.__action__, route: parsed.route };
          }
        }
      } catch { /* ignore */ }
      text = rawResponse.replace(actionMatch[0], '').trim();
    }

    return { text, action };
  }

  async sendMessage(
    userId: string,
    userRole: string,
    dto: SendMessageDto,
  ): Promise<ChatResponse> {

    // ── Rate limiting ────────────────────────────────────────────────────
    const now   = Date.now();
    const entry = rateLimitMap.get(userId);
    if (entry && now < entry.resetAt) {
      if (entry.count >= RATE_LIMIT) {
        throw new HttpException('Trop de messages. Attendez une minute avant de réessayer.', HttpStatus.TOO_MANY_REQUESTS);
      }
      entry.count++;
    } else {
      rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    }

    // ── Charger ou créer la session ───────────────────────────────────────
    let session = await this.sessionModel.findOne({
      userId: new Types.ObjectId(userId),
      threadId: dto.threadId,
    });

    if (!session) {
      session = await this.sessionModel.create({
        userId:   new Types.ObjectId(userId),
        threadId: dto.threadId,
        messages: [],
      });
      // Nouvelle session connectée
      this.incrementStats({ totalAuthSessions: 1 }).catch(() => {});
    }

    // Incrémenter le compteur de messages connectés
    this.incrementStats({ totalAuthMessages: 1 }).catch(() => {});

    // ── Ajouter le message utilisateur ────────────────────────────────────
    session.messages.push({ role: 'user', content: dto.message, timestamp: new Date() });

    // ── Sliding window : garder les 10 derniers messages ─────────────────
    const window = session.messages.slice(-SLIDING_WINDOW);

    // ── Construire le contexte Gemini ─────────────────────────────────────
    const contents = window.map(m => ({
      role:  m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    const systemWithRole = SYSTEM_PROMPT.replace(
      'RÔLE_UTILISATEUR sera injecté',
      `Le rôle de l'utilisateur est : ${userRole}`,
    );

    // ── Appel Gemini via AiService (méthode publique, pas de cast) ─────────
    const geminiResponse = await this.aiService.generateChatResponse(contents, systemWithRole);
    const rawResponse = geminiResponse || "Je suis temporairement indisponible. Si vous avez une urgence, appuyez immédiatement sur le bouton SOS rouge en bas à droite.";

    // ── Parser l'action éventuelle ────────────────────────────────────────
    let action: ChatResponse['action'] | undefined;
    let text = rawResponse;

    const actionMatch = rawResponse.match(/\{[^}]*"__action__"[^}]*\}/);
    if (actionMatch) {
      try {
        const parsed = JSON.parse(actionMatch[0]);
        if (parsed.__action__ && parsed.route) {
          // Masquer les routes admin si l'utilisateur n'est pas Admin
          const adminRoutes = ['/admin', '/admin/analytics', '/moderation'];
          const isAdminRoute = adminRoutes.some(r => parsed.route.startsWith(r));
          if (!isAdminRoute || userRole === 'Admin') {
            action = { type: parsed.__action__, route: parsed.route };
          }
        }
      } catch { /* ignore parse error */ }
      // Nettoyer le JSON de la réponse textuelle
      text = rawResponse.replace(actionMatch[0], '').trim();
    }

    // ── Sauvegarder la réponse en base ────────────────────────────────────
    session.messages.push({ role: 'assistant', content: text, timestamp: new Date() });
    await session.save();

    return { text, action };
  }

  /** Récupérer les statistiques globales du chatbot */
  async getStats(): Promise<any> {
    const stats = await this.statsModel.findOne({ key: 'global' }).lean();
    if (!stats) {
      return {
        totalAuthSessions:  0,
        totalGuestSessions: 0,
        totalAuthMessages:  0,
        totalGuestMessages: 0,
        totalSessions:      0,
        totalMessages:      0,
      };
    }
    return {
      totalAuthSessions:  stats.totalAuthSessions,
      totalGuestSessions: stats.totalGuestSessions,
      totalAuthMessages:  stats.totalAuthMessages,
      totalGuestMessages: stats.totalGuestMessages,
      totalSessions:      stats.totalAuthSessions  + stats.totalGuestSessions,
      totalMessages:      stats.totalAuthMessages  + stats.totalGuestMessages,
    };
  }
}
