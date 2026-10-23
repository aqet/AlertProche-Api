import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post, PostDocument, PostType } from '../schemas/post.schema';
import { Comment, CommentDocument } from '../schemas/comment.schema';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ModerationService } from '../common/moderation/moderation.service';
import {
  FACE_MATCH_THRESHOLD,
  MAX_SEARCH_RESULTS,
  QdrantService,
  VectorSearchResult,
} from '../qdrant/qdrant.service';
import { FacesService } from '../faces/faces.service';
import { FaceEmbedding } from '../faces/face-pipeline';
import { AiService } from 'src/ai/ai.service';
import { MailService } from 'src/mail/mail.service';
import { AppDownload, AppDownloadDocument } from '../schemas/app-download.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { WebPushService } from '../notifications/web-push.service';
import { User, UserDocument } from 'src/schemas/user.schema';
import { TrustService, TRUST_RULES } from './trust.service';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';

/**
 * Types de publication qui peuvent être confirmés par la communauté.
 * Un avis de prévention ou un signalement d'abus n'a pas à être « confirmé ».
 */
export const CONFIRMABLE_TYPES: PostType[] = ['Disparition', 'Appel à l\'aide'];

/** Réponse de la recherche par image (visage uniquement). */
export interface ImageSearchResponse {
  /** Type de recherche réellement utilisé. */
  matchType: 'face' | 'none';
  /** Pourquoi aucun résultat n'est renvoyé. */
  reason?: 'no_face' | 'no_match' | 'unavailable';
  /** Nombre de visages détectés dans la photo envoyée. */
  faceCount: number;
  /** Durée du traitement côté serveur (diagnostic). */
  durationMs: number;
  results: VectorSearchResult[];
}

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Post.name) private postModel: Model<PostDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    @InjectModel(AppDownload.name)
    private appDownloadModel: Model<AppDownloadDocument>,
// <<<<<<< HEAD
    private moderationService: ModerationService,
    private aiService: AiService,
    private mailService: MailService,
    private notificationsService: NotificationsService,
    private webPush: WebPushService,
    private qdrant: QdrantService,
    private faces: FacesService,
    private trustService: TrustService,
// =======
    // private moderationService: ModerationService,
    // private aiService: AiService,
    // private mailService: MailService,
// >>>>>>> d28424319267cfc0609fd2fa04ac0ea7a98ac44e
  ) {}

  private readonly logger = new Logger(PostsService.name);

  /** Horodatages des recherches par image, par utilisateur (rate-limit). */
  private readonly searchWindows = new Map<string, number[]>();

  /**
   * Liste des publications.
   *
   * Tri par défaut : fiabilité d'abord (votes de confirmation), puis ancienneté.
   * `sort=recent` bascule en ordre chronologique pur.
   */
  async findAll(filters?: {
    type?: string;
    location?: string;
    sort?: 'reliability' | 'recent';
    viewerId?: string;
  }) {
    const query: any = {};
    if (filters?.type) query.type = filters.type;
    if (filters?.location)
      query.location = { $regex: filters.location, $options: 'i' };

    const sort: Record<string, 1 | -1> =
      filters?.sort === 'recent'
        ? { createdAt: -1 }
        : { trustVoteCount: -1, createdAt: -1 };

    const posts = await this.postModel.find(query).sort(sort).lean();

    // État de confiance calculé sur les documents bruts (les ID des votants
    // ne sont jamais renvoyés au client).
    await this.trustService.computeTrustForPosts(posts);

    // Le vote du visiteur est calculé AVANT l'enrichissement : après, la
    // liste des votants n'est plus disponible.
    const confirmedByViewer = new Map<string, boolean>();
    const reportedByViewer = new Map<string, boolean>();
    if (filters?.viewerId) {
      for (const p of posts) {
        confirmedByViewer.set(
          p._id.toString(),
          this.hasConfirmed(p, filters.viewerId),
        );
        reportedByViewer.set(
          p._id.toString(),
          this.hasReported(p, filters.viewerId),
        );
      }
    }

    // Enrichir avec pseudo auteur, compteur commentaires et état de confiance
    const enriched = await Promise.all(posts.map((p) => this.enrichPost(p)));
    for (const p of enriched) {
      p.hasConfirmed = confirmedByViewer.get(p._id) ?? false;
      p.hasReported = reportedByViewer.get(p._id) ?? false;
    }
    return enriched;
  }

  async findOne(id: string, viewerId?: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id).lean();
    if (!post) throw new NotFoundException('Publication introuvable.');
    await this.trustService.computeTrustForPosts([post]);
    const hasConfirmed = this.hasConfirmed(post, viewerId);
    const hasReported = this.hasReported(post, viewerId);
    const enriched = await this.enrichPost(post);
    enriched.hasConfirmed = hasConfirmed;
    enriched.hasReported = hasReported;
    return enriched;
  }

  async findMyPosts(userId: string) {
    const posts = await this.postModel
      .find({ author_id: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
    await this.trustService.computeTrustForPosts(posts);
    return Promise.all(posts.map((p) => this.enrichPost(p)));
  }

  async findReported() {
    const posts = await this.postModel
      .find({ isReported: true })
      .sort({ createdAt: -1 })
      .lean();
    await this.trustService.computeTrustForPosts(posts);
    return Promise.all(posts.map((p) => this.enrichPost(p)));
  }

  async incrementAppDownload() {
    const key = 'android-app';
    const record = await this.appDownloadModel.findOneAndUpdate(
      { key },
      { $setOnInsert: { key }, $inc: { count: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return { key, count: record.count };
  }

  async getAppDownloadCount() {
    const record = await this.appDownloadModel
      .findOne({ key: 'android-app' })
      .lean();
    return { key: 'android-app', count: record?.count ?? 0 };
  }

  /**
   * Recherche par image : uniquement par visage.
   *
   * L'embedding généraliste (Gemini) n'est plus utilisé en secours : sur des
   * affiches et des photos sans rapport il renvoyait des scores élevés
   * (0,7) pour des annonces visuellement différentes, ce qui donnait des
   * « correspondances » trompeuses. Ici, pas de visage = pas de résultat,
   * et l'interface explique pourquoi.
   */
  async searchSimilarImages(
    fileBuffer: Buffer,
    _mimeType: string,
    userId?: string,
  ): Promise<ImageSearchResponse> {
    this.assertSearchRateLimit(userId);
    const startedAt = Date.now();
    const uid = userId ?? 'anonyme';

    let faces: FaceEmbedding[];
    try {
      faces = (await this.faces.analyzeFaces(fileBuffer)).faces;
    } catch (err: any) {
      // Moteur indisponible (modèles absents, panne WASM…) : on le dit
      // franchement plutôt que de renvoyer des résultats non pertinents.
      this.logger.error(`Extraction faciale échouée : ${err?.message ?? err}`);
      return {
        matchType: 'none',
        reason: 'unavailable',
        faceCount: 0,
        durationMs: Date.now() - startedAt,
        results: [],
      };
    }

    if (faces.length === 0) {
      this.logger.log(
        `Recherche par image (uid=${uid}) : aucun visage détecté (${Date.now() - startedAt} ms).`,
      );
      return {
        matchType: 'none',
        reason: 'no_face',
        faceCount: 0,
        durationMs: Date.now() - startedAt,
        results: [],
      };
    }

    // On interroge au maximum les 3 plus grands visages (photos de groupe).
    const bestByPost = new Map<string, VectorSearchResult>();
    for (const face of faces.slice(0, 3)) {
      const hits = await this.qdrant.searchFaces(face.embedding, 10);
      for (const hit of hits) {
        if (hit.score < FACE_MATCH_THRESHOLD) continue;
        const current = bestByPost.get(hit._id);
        // Une publication peut avoir plusieurs visages : on garde le
        // meilleur score pour chacune.
        if (!current || hit.score > current.score) {
          bestByPost.set(hit._id, hit);
        }
      }
    }

    const results = [...bestByPost.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_RESULTS);

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `Recherche par image (uid=${uid}) : ${faces.length} visage(s), ` +
        `${results.length} correspondance(s) ≥ ${FACE_MATCH_THRESHOLD} (${durationMs} ms).`,
    );

    return {
      matchType: results.length > 0 ? 'face' : 'none',
      reason: results.length > 0 ? undefined : 'no_match',
      faceCount: faces.length,
      durationMs,
      results,
    };
  }

  /**
   * Limite simple des recherches par image, par utilisateur.
   *
   * En mémoire : sur Vercel (serverless), chaque instance a son propre
   * compteur. C'est un garde-fou anti-abus best-effort, pas une garantie
   * distribuée.
   */
  private assertSearchRateLimit(userId?: string): void {
    if (!userId) return;

    const WINDOW_MS = 60_000;
    const MAX_PER_WINDOW = 12;
    const now = Date.now();

    const recent = (this.searchWindows.get(userId) ?? []).filter(
      (timestamp) => now - timestamp < WINDOW_MS,
    );

    if (recent.length >= MAX_PER_WINDOW) {
      throw new HttpException(
        'Trop de recherches par image. Réessayez dans une minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.searchWindows.set(userId, recent);

    // Purge occasionnelle pour éviter une fuite mémoire.
    if (this.searchWindows.size > 2000) {
      for (const [key, timestamps] of this.searchWindows) {
        if (
          timestamps.length === 0 ||
          now - timestamps[timestamps.length - 1] > WINDOW_MS
        ) {
          this.searchWindows.delete(key);
        }
      }
    }
  }

  async create(
    dto: CreatePostDto,
    user: any,
    file: Express.Multer.File,
    imageUrl?: string,
  ) {
    // Blocage de publication : 3 avertissements (fauxes alertes confirmées
    // par la modération) → seule une intervention d'un Admin peut lever.
    const canPublish = await this.trustService.canPublish(user._id.toString());
    if (!canPublish) {
      throw new ForbiddenException(
        "Votre compte est bloqué de publication après 3 alertes confirmées fausses. Contactez un administrateur.",
      );
    }

    // Modération
    // this.moderationService.validateOrThrow(dto.title);
    // this.moderationService.validateOrThrow(dto.content);
    let imageEmbedding: number[] | null = null;
    if (file) {
      const base64Image = file.buffer.toString('base64');
      imageEmbedding = await this.aiService.generateImageEmbedding(
        base64Image,
        file.mimetype,
      );
    }

    let aiResult = this.aiService.moderateContent(dto.title);
    if (
      (await aiResult).decision == 'BAN' &&
      (await aiResult).confidence >= 0.9
    ) {
      return aiResult;
    } else {
      aiResult = this.aiService.moderateContent(dto.content);
      if (
        (await aiResult).decision == 'BAN' &&
        (await aiResult).confidence >= 0.9
      ) {
        return aiResult;
      } else {
        const post = await this.postModel.create({
          author_id: new Types.ObjectId(user._id.toString()),
          title: dto.title,
          content: dto.content,
          location: dto.location,
          type: dto.type,
          isAnonymous: dto.isAnonymous,
          image_url: imageUrl || null,
          isActive: true,
        });

        // Indexation du vecteur dans Qdrant (remplace l'ancien champ Mongo
        // `imageEmbedding`). Un échec n'empêche jamais la publication : le post
        // est seulement absent de la recherche par image jusqu'à ré-indexation.
        if (imageEmbedding) {
          await this.indexPostVector(post, imageEmbedding);
        }

        // Visages : uniquement pour les avis de disparition, et uniquement si
        // l'image est disponible. Échec non bloquant.
        if (file && dto.type === 'Disparition') {
          await this.indexPostFaces(post, file.buffer);
        }

        if (dto.type == 'Disparition' || dto.type == 'Abus') {
          this.mailService.sendMailByLocation(post);
        }


        const users = await this.userModel
          .find({
            'token.0': { $exists: true },
          })
          .select('token') // Récupère uniquement le champ token
          .lean();

        users.map((user) => {
          user.token.map((token) => {
            this.notificationsService.envoyerNotification(
              token,
              'Alert!!',
              `Nouvelle ${dto.type} a ${dto.location}`,
            );
          });
        });
        console.log('users:', users);
        // users: [
        //   {
        //     _id: new ObjectId('6a1d6380f2efff3c892e6caf'),
        //     token: [
        //       'fC_Y-Id5TM6DMANIgr7OC1:APA91bFO_eebwnZivI7sd7EJ-gb_5h0AuTD2SfWYjpF74vj7suSagjcdqWVtOSjtalW2yHBGLEMmnsMxGgnOVTwMJCUxQpmDWS-ivLERzS3XkpmXSY8Ei1s',
        //     ],
        //   },
        //   {
        //     _id: new ObjectId('6a1d63abf2efff3c892e6cbf'),
        //     token: [
        //       'feIqXwM2S2WVt9XcDIejJj:APA91bHTirhkAmhVkxRUZwakg83T2Do0jxFvlrQ6pEcwAgLFXtNTP-TkD9CsygWQeVKsHHuwWZ5hZjJMvs4FaRDXXVIFXQ57I6YVnx07FOD5ABMo_5B_PO0',
        //     ],
        //   },
        // ];


        // Notifications push en arrière-plan
        this.sendNewPostNotification(post.title, post._id.toString()).catch(err =>
          this.logger.error('sendNewPostNotification échoué', err)
        );
// >>>>>>> d28424319267cfc0609fd2fa04ac0ea7a98ac44e
        return this.enrichPost(post.toObject(), user);
      }
    }
  }

  /**
   * Envoie une notification push FCM ou Web Push à tous les appareils enregistrés.
   * Détecte automatiquement le type de token (FCM string vs PushSubscription JSON).
   */
  async sendNewPostNotification(postTitle: string, postId: string) {
    const users = await this.userModel.find({ 'token.0': { $exists: true } }, { _id: 1, token: 1 }).lean().exec();
    const allTokens = [...new Set(users.flatMap((u) => u.token).filter(Boolean))];

    if (allTokens.length === 0) {
      this.logger.warn('Notification post ignorée : aucun token enregistré.');
      return;
    }

    // Séparer FCM et Web Push
    const fcmTokens     = allTokens.filter(t => !WebPushService.isWebPushToken(t));
    const webPushTokens = allTokens.filter(t =>  WebPushService.isWebPushToken(t));

    this.logger.log(`🔔 Notification post "${postId}" → ${fcmTokens.length} FCM + ${webPushTokens.length} Web Push`);

    const title = '🚨 Nouvelle alerte AlertProche';
    const body  = postTitle;
    const data  = { postId: postId.toString(), type: 'NEW_POST' };

    // ── Web Push ─────────────────────────────────────────────────────────
    const expiredWebPush: string[] = [];
    await Promise.all(
      webPushTokens.map(async (token) => {
        const sent = await this.webPush.sendNotification(token, { title, body, data });
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

    // ── FCM ───────────────────────────────────────────────────────────────
    if (fcmTokens.length === 0) return;

    try { getMessaging(); } catch {
      this.logger.error('Firebase Admin non initialisé - notification post FCM ignorée.');
      return;
    }

    const BATCH_SIZE = 500;
    let totalSuccess = 0;
    let totalFailure = 0;
    const invalidTokens: string[] = [];

    for (let i = 0; i < fcmTokens.length; i += BATCH_SIZE) {
      const batchTokens = fcmTokens.slice(i, i + BATCH_SIZE);
      const message: MulticastMessage = {
        tokens: batchTokens,
        notification: { title, body },
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'alertproche_notifications',
            sound: 'default',
            priority: 'max',
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
        const response = await getMessaging().sendEachForMulticast(message);
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;
        response.responses.forEach((res, idx) => {
          if (!res.success) {
            const code = res.error?.code;
            if (
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered'
            ) invalidTokens.push(batchTokens[idx]);
          }
        });
      } catch (error) {
        this.logger.error(`Erreur FCM lot ${Math.floor(i / BATCH_SIZE) + 1}:`, error instanceof Error ? error.message : String(error));
      }
    }

    if (invalidTokens.length > 0) {
      await this.userModel.updateMany(
        { token: { $in: invalidTokens } },
        { $pull: { token: { $in: invalidTokens } } },
      );
      this.logger.log(`🗑 ${invalidTokens.length} token(s) FCM invalide(s) supprimé(s).`);
    }

    this.logger.log(`✅ Post notification terminée - ${totalSuccess} succès FCM, ${totalFailure} échecs.`);
  }

  async update(id: string, dto: UpdatePostDto, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    // Vérifier propriété (sauf Admin/Modérateur)
    if (
      user.role === 'Standard' &&
      post.author_id.toString() !== user._id.toString()
    ) {
      throw new ForbiddenException(
        'Vous ne pouvez modifier que vos propres publications.',
      );
    }

    if (dto.title) this.moderationService.validateOrThrow(dto.title);
    if (dto.content) this.moderationService.validateOrThrow(dto.content);

    const updated = await this.postModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean();

    return this.enrichPost(updated!);
  }

  async toggleActive(id: string, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    if (!['Moderateur', 'Admin'].includes(user.role)) {
      throw new ForbiddenException('Permissions insuffisantes.');
    }

    const updated = await this.postModel
      .findByIdAndUpdate(
        id,
        { $set: { isActive: !post.isActive } },
        { new: true },
      )
      .lean();

    return this.enrichPost(updated!);
  }

  /**
   * Signalement d'une publication.
   *
   * Le signalement est désormais CUMULATIF et nominatif côté serveur :
   * - `reportedBy` liste les membres ayant signalé (une seule fois chacun),
   * - l'analyse IA n'est lancée qu'AU PREMIER signalement (les suivants
   *   sont instantanés et ne relancent pas d'appel IA),
   * - le seuil de 3 signalements distincts fait passer l'alerte en
   *   « En vérification » (visible, jamais masquée) et notifie le staff.
   */
  async report(id: string, reason: string, user?: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    const reporterId = user?._id ? String(user._id) : null;
    const alreadyReported = reporterId
      ? (post.reportedBy ?? []).some((r: string) => String(r) === reporterId)
      : false;

    if (alreadyReported) {
      throw new HttpException(
        'Vous avez déjà signalé cette publication.',
        HttpStatus.CONFLICT,
      );
    }

    const isFirstReport = (post.reportedBy ?? []).length === 0;

    let autoBanned = false;
    let aiAnalysis: any = null;

    if (isFirstReport) {
      // L'IA n'est sollicitée qu'une fois par publication.
      const aiResult = await this.aiService.moderateContent(post.content, reason);
      aiAnalysis = {
        decision: aiResult.decision,
        confidence: aiResult.confidence,
        reason: aiResult.reasoning,
      };

      // Décision sécurisée : on n'automatise le bannissement que si l'IA est
      // formelle (confiance supérieure à 90 %).
      if (aiResult.decision === 'BAN' && aiResult.confidence >= 0.9) {
        autoBanned = true;
      }
    }

    const update: any = {
      $set: { isReported: true },
      $push: { reportedBy: reporterId ?? 'anonyme' },
    };

    if (isFirstReport) {
      update.$set.isActive = !autoBanned;
      update.$addToSet = {
        reportReasons: `${reason} (Analyse IA : ${aiAnalysis.decision} - ${aiAnalysis.reason} - Confiance : ${aiAnalysis.confidence * 100}%)`,
      };
    } else {
      // Les signalements suivants sont conservés (cumul) mais l'IA n'est pas
      // relancée : on ajoute juste le motif court.
      update.$addToSet = { reportReasons: reason };
    }

    const updated = await this.postModel
      .findByIdAndUpdate(id, update, { new: true })
      .lean();

    const reportCount = (updated?.reportedBy ?? []).length;
    const underReview = reportCount >= TRUST_RULES.REVIEW_THRESHOLD;

    // Le staff est prévenu dès que l'alerte passe « En vérification ».
    if (underReview) {
      this.notifyStaffUnderReview(updated, reportCount);
    }

    return {
      success: true,
      autoBanned: autoBanned,
      reportCount,
      underReview,
      message: autoBanned
        ? 'Ce contenu a été temporairement masqué suite à une détection automatique de violation des règles.'
        : 'Votre signalement a bien été pris en compte et va être analysé.',
      aiAnalysis,
    };
  }

  /** Prévient le staff qu'une alerte passe en vérification. */
  private notifyStaffUnderReview(post: any, reportCount: number): void {
    this.logger.warn(
      `Alerte en vérification : ${post?._id} (${reportCount} signalements distincts)`,
    );
  }

  /**
   * Vote de confirmation « Je confirme cette alerte ».
   *
   * - un seul vote par personne (bascule on/off),
   * - impossible de voter pour sa propre alerte,
   * - compte d'au moins 24 h d'ancienneté,
   * - réservé aux alertes de type « Disparition » et « Appel à l'aide ».
   */
  async confirm(id: string, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    if (!user?._id)
      throw new ForbiddenException('Connectez-vous pour confirmer une alerte.');

    const post: any = await this.postModel.findById(id).lean();
    if (!post) throw new NotFoundException('Publication introuvable.');

    if (post.author_id.toString() === String(user._id)) {
      throw new ForbiddenException(
        'Vous ne pouvez pas confirmer votre propre alerte.',
      );
    }

    if (!CONFIRMABLE_TYPES.includes(post.type)) {
      throw new ForbiddenException(
        "Ce type de publication ne se confirme pas (seules les alertes de disparition et les appels à l'aide le permettent).",
      );
    }

    // Ancienneté du compte : 24 h minimum (anti création de masse de comptes).
    const account: any = await this.userModel
      .findById(user._id)
      .select('createdAt credibility strikes role')
      .lean();
    if (!account) throw new NotFoundException('Compte introuvable.');

    const createdAt = account.createdAt ? new Date(account.createdAt) : null;
    if (createdAt) {
      const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000;
      if (ageHours < TRUST_RULES.MIN_ACCOUNT_AGE_HOURS) {
        throw new ForbiddenException(
          "Votre compte doit avoir au moins 24 heures d'ancienneté pour confirmer une alerte.",
        );
      }
    }

    const voterId = String(user._id);
    const votes: string[] = post.trustVotes ?? [];
    const hasVoted = votes.some((v: string) => String(v) === voterId);

    // État AVANT le vote : sert à détecter le passage au badge
    // « Confirmée par la communauté » (déclenche les points de l'auteur).
    await this.trustService.computeTrustForPosts([post]);
    const wasCommunityConfirmed = post.communityConfirmed === true;

    const updated: any = await this.postModel
      .findByIdAndUpdate(
        id,
        hasVoted
          ? { $pull: { trustVotes: voterId }, $inc: { trustVoteCount: -1 } }
          : { $addToSet: { trustVotes: voterId }, $inc: { trustVoteCount: 1 } },
        { new: true },
      )
      .lean();

    // Participation récompensée : +1 de crédibilité (1 fois par jour, plafonné).
    // Uniquement quand le vote est AJOUTÉ, jamais quand il est retiré.
    // Fait AVANT le recalcul pour que ce vote compte tout de suite s'il
    // fait franchir le seuil de 30 au votant.
    if (!hasVoted) {
      await this.trustService.rewardConfirmationVote(voterId);
    }

    const newVotes: string[] = updated?.trustVotes ?? [];
    await this.trustService.computeTrustForPosts([updated]);

    // L'alerte vient d'être cautionnée par la communauté → l'auteur gagne
    // des points de confiance (une seule fois par alerte).
    if (!wasCommunityConfirmed && updated?.communityConfirmed) {
      await this.trustService.addCredibility(
        post.author_id.toString(),
        TRUST_RULES.POINTS_CONFIRMED_ALERT,
      );
      await this.trustService.incrementCounter(
        post.author_id.toString(),
        'confirmedAlerts',
      );
      // Notifier l'auteur que son alerte est confirmée par la communauté
      try {
        const author = await this.userModel
          .findById(post.author_id)
          .select('token pseudo')
          .lean();
        const tokens: string[] = author?.token ?? [];
        for (const t of tokens) {
          await this.notificationsService.envoyerNotification(
            t,
            'Votre alerte est confirmée par la communauté',
            `Votre alerte « ${post.title} » a atteint le seuil de confirmation communautaire.`,
          );
        }
      } catch (e) {
        this.logger.warn(`Impossible d'envoyer la notification de confirmation communautaire: ${e}`);
      }
    }

    // Notifier l'auteur qu'un membre a confirmé son alerte
    if (!hasVoted && updated?.trustVoteCount > (post.trustVoteCount ?? 0)) {
      try {
        const author = await this.userModel
          .findById(post.author_id)
          .select('token pseudo')
          .lean();
        const tokens: string[] = author?.token ?? [];
        const voterPseudo = account?.pseudo || 'Un membre';
        for (const t of tokens) {
          await this.notificationsService.envoyerNotification(
            t,
            'Confirmation sur votre alerte',
            `${voterPseudo} a confirmé votre alerte « ${post.title} ».`,
          );
        }
      } catch (e) {
        this.logger.warn(`Impossible d'envoyer la notification de confirmation: ${e}`);
      }
    }

    return {
      success: true,
      hasConfirmed: !hasVoted,
      trustVoteCount: newVotes.length,
      trustedVoteCount: updated?.trustedVoteCount ?? 0,
      communityConfirmed: updated?.communityConfirmed ?? false,
      viewsCount: updated?.viewsCount ?? 0,
      reportCount: (updated?.reportedBy ?? []).length,
      underReview: updated?.underReview ?? false,
    };
  }

  /** Incrémente le compteur de vues (une fois par appel). */
  async incrementView(id: string) {
    if (!Types.ObjectId.isValid(id)) return;
    await this.postModel.updateOne({ _id: id }, { $inc: { viewsCount: 1 } });
  }

  /**
   * Décision du staff : l'alerte est confirmée fausse.
   * C'est le SEUL chemin vers la réputation négative (1 avertissement).
   */
  async markFalseAlert(id: string, user: any) {
    if (!['Moderateur', 'Admin'].includes(user?.role)) {
      throw new ForbiddenException('Permissions insuffisantes.');
    }
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');

    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    const updated = await this.postModel
      .findByIdAndUpdate(
        id,
        { $set: { isFalseAlert: true, isActive: false, isReported: true } },
        { new: true },
      )
      .lean();

    // 1 avertissement sur le compte de l'auteur.
    await this.trustService.applyStrike(
      post.author_id.toString(),
      `Alerte confirmée fausse par ${user.pseudo ?? user._id}`,
    );

    return { success: true, post: await this.enrichPost(updated) };
  }

  /** Retire un avertissement (erreur du staff). */
  async removeStrike(userId: string, user: any) {
    if (user?.role !== 'Admin') {
      throw new ForbiddenException('Seul un administrateur peut retirer un avertissement.');
    }
    await this.trustService.removeStrike(userId);
    return { success: true };
  }

  async resolvePost(id: string, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    const isAdminOrMod = ['Admin', 'Moderateur'].includes(user.role);
    if (post.isAnonymous === true && !isAdminOrMod) {
      throw new ForbiddenException(
        'Seul un administrateur ou modérateur peut résoudre une alerte anonyme.',
      );
    }
    if (
      post.isAnonymous !== true &&
      !isAdminOrMod &&
      post.author_id.toString() !== user._id.toString()
    ) {
      throw new ForbiddenException(
        'Vous ne pouvez résoudre que vos propres publications.',
      );
    }

    const updated = await this.postModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            isResolved: true,
            resolvedAt: new Date(),
            resolvedBy: user.pseudo ?? user._id.toString(),
          },
        },
        { new: true },
      )
      .lean();

    // Réputation : une alerte résolue est le signal le plus fort.
    await this.trustService.addCredibility(
      post.author_id.toString(),
      TRUST_RULES.POINTS_RESOLVED_ALERT,
    );
    await this.trustService.incrementCounter(
      post.author_id.toString(),
      'resolvedAlerts',
    );

    await this.trustService.computeTrustForPosts([updated]);
    return this.enrichPost(updated!);
  }

  async unresolvePost(id: string, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    const isAdminOrMod = ['Admin', 'Moderateur'].includes(user.role);
    if (post.isAnonymous === true && !isAdminOrMod) {
      throw new ForbiddenException(
        'Seul un administrateur ou modérateur peut réouvrir une alerte anonyme.',
      );
    }
    if (
      post.isAnonymous !== true &&
      !isAdminOrMod &&
      post.author_id.toString() !== user._id.toString()
    ) {
      throw new ForbiddenException(
        'Vous ne pouvez réouvrir que vos propres publications.',
      );
    }

    const updated = await this.postModel
      .findByIdAndUpdate(
        id,
        { $set: { isResolved: false, resolvedAt: null, resolvedBy: null } },
        { new: true },
      )
      .lean();

    return this.enrichPost(updated!);
  }

  async clearReport(id: string, user: any) {
    if (!['Moderateur', 'Admin'].includes(user.role)) {
      throw new ForbiddenException('Permissions insuffisantes.');
    }
    await this.postModel.findByIdAndUpdate(id, {
      $set: { isReported: false, reportReasons: [], isFalseAlert: false },
      $unset: { reportedBy: 1 },
    });
  }

  async remove(id: string, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    if (
      user.role === 'Standard' &&
      post.author_id.toString() !== user._id.toString()
    ) {
      throw new ForbiddenException(
        'Vous ne pouvez supprimer que vos propres publications.',
      );
    }

    // Supprimer en cascade les commentaires
    await this.commentModel.deleteMany({ post_id: new Types.ObjectId(id) });
    await this.postModel.findByIdAndDelete(id);

    // Suppression des vecteurs Qdrant. Non bloquant : si l'appel échoue, le
    // point orphelin est de toute façon filtré côté frontend (qui ne garde que
    // les _id présents dans sa liste de publications).
    const [vectorResult, facesResult] = await Promise.allSettled([
      this.qdrant.deletePost(id),
      this.qdrant.deletePostFaces(id),
    ]);

    if (vectorResult.status === 'rejected') {
      this.logger.error(
        `Suppression Qdrant (vecteur) échouée pour le post ${id}: ${vectorResult.reason?.message ?? vectorResult.reason}`,
      );
    }
    if (facesResult.status === 'rejected') {
      this.logger.error(
        `Suppression Qdrant (visages) échouée pour le post ${id}: ${facesResult.reason?.message ?? facesResult.reason}`,
      );
    }
  }

  /**
   * Indexe (ou ré-indexe) le vecteur d'image d'une publication dans Qdrant.
   * Échec non bloquant : loggé, la publication reste créée.
   */
  private async indexPostVector(post: any, vector: number[]): Promise<void> {
    try {
      await this.qdrant.upsertPost(this.toVectorPayload(post), vector);
    } catch (err: any) {
      this.logger.error(
        `Indexation Qdrant échouée pour le post ${post._id}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Détecte et indexe les visages d'un avis de disparition.
   * Échec non bloquant : la publication reste créée, elle sera simplement
   * absente de la recherche par visage.
   */
  private async indexPostFaces(post: any, buffer: Buffer): Promise<void> {
    if (!this.faces.available) return;

    try {
      const { faces } = await this.faces.extractFaces(buffer);

      await this.qdrant.replacePostFaces(
        this.toVectorPayload(post),
        faces.map((face) => ({
          embedding: face.embedding,
          score: face.score,
          bbox: face.bbox,
        })),
      );

      this.logger.log(
        `Qdrant : ${faces.length} visage(s) indexé(s) pour le post ${post._id}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Indexation des visages échouée pour le post ${post._id}: ${err?.message ?? err}`,
      );
    }
  }

  /** Métadonnées communes aux collections `post_images` et `post_faces`. */
  private toVectorPayload(post: any) {
    return {
      postId: post._id.toString(),
      title: post.title,
      location: post.location,
      type: post.type,
      image_url: post.image_url ?? null,
      isActive: post.isActive ?? true,
      isResolved: post.isResolved ?? false,
      createdAt: post.createdAt ?? null,
    };
  }

  private async enrichPost(post: any, authorUser?: any) {
    const commentCount = await this.commentModel.countDocuments({
      post_id: post._id,
    });

    let authorPseudo = 'Anonyme';
    let authorBadge: 'none' | 'new' | 'confirmed' | 'reference' = 'none';

    // N'afficher le pseudo que si isAnonymous est explicitement false
    if (post.isAnonymous === false || post.isAnonymous === 'false') {
      if (authorUser) {
        // Le user peut être un doc Mongoose ou un objet plain
        const plain =
          authorUser.toObject?.() ?? authorUser;
        authorPseudo = plain.pseudo || 'Inconnu';
        authorBadge = this.trustService.getBadge(plain);
      } else {
        try {
          const author = (await this.postModel.db
            .model('User')
            .findById(post.author_id)
            .select('pseudo credibility createdAt role strikes')
            .lean()) as any;
          authorPseudo = author?.pseudo || 'Inconnu';
          authorBadge = this.trustService.getBadge(author ?? {});
        } catch {
          authorPseudo = 'Inconnu';
        }
      }
    }

    return {
      _id: post._id.toString(),
      author_id: post.author_id.toString(),
      authorPseudo,
      authorBadge,
      isAnonymous: post.isAnonymous === true || post.isAnonymous === 'true',
      title: post.title,
      content: post.content,
      location: post.location,
      type: post.type,
      image_url: post.image_url || '',
      isActive: post.isActive,
      isReported: post.isReported,
      reportReasons: post.reportReasons,
      createdAt: post.createdAt,
      commentCount,
      isResolved: post.isResolved ?? false,
      resolvedAt: post.resolvedAt ?? null,
      resolvedBy: post.resolvedBy ?? null,
      /* ── Confiance communautaire ─────────────────────────────── */
      trustVoteCount: post.trustVoteCount ?? (post.trustVotes ?? []).length,
      trustedVoteCount: post.trustedVoteCount ?? 0,
      communityConfirmed: post.communityConfirmed ?? false,
      reportCount: post.reportCount ?? (post.reportedBy ?? []).length,
      underReview: post.underReview ?? false,
      viewsCount: post.viewsCount ?? 0,
      isFalseAlert: post.isFalseAlert ?? false,
      hasConfirmed: false,
      hasReported: false,
    };
  }

  /** Le membre connecté a-t-il déjà confirmé cette alerte ? */
  private hasConfirmed(post: any, viewerId?: string): boolean {
    if (!viewerId) return false;
    return (post.trustVotes ?? []).some((id: string) => String(id) === String(viewerId));
  }

  /** Le membre connecté a-t-il déjà signalé cette alerte ? */
  private hasReported(post: any, viewerId?: string): boolean {
    if (!viewerId) return false;
    return (post.reportedBy ?? []).some((id: string) => String(id) === String(viewerId));
  }
}
