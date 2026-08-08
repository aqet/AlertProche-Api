import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ObjectId, Types } from 'mongoose';
import { Post, PostDocument } from '../schemas/post.schema';
import { Comment, CommentDocument } from '../schemas/comment.schema';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ModerationService } from '../common/moderation/moderation.service';
import { AiService } from 'src/ai/ai.service';
import { MailService } from 'src/mail/mail.service';
import {
  AppDownload,
  AppDownloadDocument,
} from '../schemas/app-download.schema';

import { NotificationsService } from '../notifications/notifications.service';
import { User, UserDocument } from 'src/schemas/user.schema';
import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
// =======
// import { User, UserDocument } from 'src/schemas/user.schema';
// import { getMessaging, MulticastMessage } from 'firebase-admin/messaging';
// >>>>>>> d28424319267cfc0609fd2fa04ac0ea7a98ac44e

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Post.name) private postModel: Model<PostDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    @InjectModel(AppDownload.name)
    private appDownloadModel: Model<AppDownloadDocument>,
// <<<<<<< HEAD
    // @InjectModel(User.name) private userModel: Model<UserDocument>,
    private moderationService: ModerationService,
    private aiService: AiService,
    private mailService: MailService,
    private notificationsService: NotificationsService,
// =======
    // private moderationService: ModerationService,
    // private aiService: AiService,
    // private mailService: MailService,
// >>>>>>> d28424319267cfc0609fd2fa04ac0ea7a98ac44e
  ) {}

  private readonly logger = new Logger(PostsService.name);

  async findAll(filters?: { type?: string; location?: string }) {
    const query: any = {};
    if (filters?.type) query.type = filters.type;
    if (filters?.location)
      query.location = { $regex: filters.location, $options: 'i' };

    const posts = await this.postModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Enrichir avec pseudo auteur et compteur commentaires
    return Promise.all(posts.map((p) => this.enrichPost(p)));
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id).lean();
    if (!post) throw new NotFoundException('Publication introuvable.');
    return this.enrichPost(post);
  }

  async findMyPosts(userId: string) {
    const posts = await this.postModel
      .find({ author_id: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
    return Promise.all(posts.map((p) => this.enrichPost(p)));
  }

  async findReported() {
    const posts = await this.postModel
      .find({ isReported: true })
      .sort({ createdAt: -1 })
      .lean();
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

  async searchSimilarImages(fileBuffer: Buffer, mimeType: string) {
    // 1️⃣ Conversion du Buffer brut en Base64 pour l'API Gemini
    const base64Image = fileBuffer.toString('base64');

    // 2️⃣ Appel à Gemini pour générer l'Embedding (la signature mathématique)
    const response = await this.aiService.generateImageEmbedding(
      base64Image,
      mimeType,
    );

    const targetEmbedding = response; // Notre tableau de 1408 nombres

    // 3️⃣ Requête vectorielle dans MongoDB Atlas
    return this.postModel.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index_alertProche', // Le nom de ton index sur Atlas
          path: 'imageEmbedding', // Le champ dans ton schéma MongoDB
          queryVector: targetEmbedding, // Les 1408 nombres de l'image recherchée
          numCandidates: 100, // Analyse les 100 documents les plus proches
          limit: 5, // Renvoie le top 5 des meilleurs résultats
        },
      },
      {
        $project: {
          title: 1,
          imageUrl: 1,
          location: 1,
          score: { $meta: 'vectorSearchScore' }, // Donne la jauge de ressemblance (0 à 1)
        },
      },
    ]);
  }

  async create(
    dto: CreatePostDto,
    user: any,
    file: Express.Multer.File,
    imageUrl?: string,
  ) {
    // Modération
    // this.moderationService.validateOrThrow(dto.title);
    // this.moderationService.validateOrThrow(dto.content);
    const base64Image = file.buffer.toString('base64');
    const imageEmbedding = await this.aiService.generateImageEmbedding(
      base64Image,
      file.mimetype,
    );

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
          imageEmbedding: imageEmbedding,
          isActive: true,
        });

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
   * Envoie une notification push FCM à tous les appareils enregistrés.
   * Nettoie automatiquement les tokens invalides/expirés.
   */
  async sendNewPostNotification(postTitle: string, postId: string) {
    // Guard Firebase
    try {
      getMessaging();
    } catch {
      this.logger.error('Firebase Admin non initialisé — notification post ignorée.');
      return;
    }

    const users = await this.userModel.find({ 'token.0': { $exists: true } }, { _id: 1, token: 1 }).lean().exec();
    const allTokens = [...new Set(users.flatMap((user) => user.token).filter(Boolean))];

    if (allTokens.length === 0) {
      this.logger.warn('Notification push ignorée : aucun token enregistré.');
      return;
    }

    this.logger.log(`🔔 Envoi de notification push à ${allTokens.length} appareil(s) — post: ${postId}`);

    const BATCH_SIZE = 500;
    let totalSuccess = 0;
    let totalFailure = 0;
    const invalidTokens: string[] = [];

    for (let i = 0; i < allTokens.length; i += BATCH_SIZE) {
      const batchTokens = allTokens.slice(i, i + BATCH_SIZE);

      const message: MulticastMessage = {
        tokens: batchTokens,
        notification: {
          title: '🚨 Nouvelle alerte AlertProche',
          body: postTitle,
        },
        data: {
          postId: postId.toString(),
          type: 'NEW_POST',
        },
        // Force l'affichage en bannière plein écran sur Android
        android: {
          priority: 'high',
          notification: {
            channelId: 'alertproche_notifications', // Canal créé dans l'app mobile avec IMPORTANCE_HIGH
            sound: 'default',
            priority: 'max',              // Bannière Heads-Up visible même en veille
            visibility: 'public',         // Visible sur l'écran verrouillé
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        // iOS
        apns: {
          headers: {
            'apns-priority': '10',
            'apns-push-type': 'alert',
          },
          payload: {
            aps: {
              sound: 'default',
              badge: 1,
              'content-available': 1,
            },
          },
        },
      };

      try {
        const response = await getMessaging().sendEachForMulticast(message);
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;

        // Collecter les tokens invalides pour les supprimer
        response.responses.forEach((res, idx) => {
          if (!res.success) {
            const code = res.error?.code;
            if (
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered'
            ) {
              invalidTokens.push(batchTokens[idx]);
            }
            this.logger.warn(`Token ${batchTokens[idx].slice(0, 20)}... échoué : ${code}`);
          }
        });

        this.logger.log(`Lot ${Math.floor(i / BATCH_SIZE) + 1} : ${response.successCount} succès / ${response.failureCount} échecs`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Erreur FCM lot ${Math.floor(i / BATCH_SIZE) + 1} :`, errorMessage);
      }
    }

    // Supprimer les tokens invalides de la base
    if (invalidTokens.length > 0) {
      await this.userModel.updateMany(
        { token: { $in: invalidTokens } },
        { $pull: { token: { $in: invalidTokens } } },
      );
      this.logger.log(`🗑 ${invalidTokens.length} token(s) invalide(s) supprimé(s) de la base.`);
    }

    this.logger.log(`✅ Notification terminée — ${totalSuccess} succès, ${totalFailure} échecs sur ${allTokens.length} appareils.`);
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

  async report(id: string, reason: string) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    const aiResult = await this.aiService.moderateContent(post.content, reason);
    // Paramètres de décision par défaut
    let autoBanned = false;
    let statusUpdate = 'PENDING_HUMAN_REVIEW';

    // 3. Logique décisionnelle sécurisée (Human-in-the-loop)
    // On n'automatise le bannissement que si l'IA est formelle (confiance supérieure à 85%)
    if (aiResult.decision === 'BAN' && aiResult.confidence >= 0.9) {
      autoBanned = true;
      statusUpdate = 'ARCHIVED_BY_AI';
    }

    await this.postModel.findByIdAndUpdate(id, {
      $set: {
        isReported: true,
        isActive: !autoBanned,
      },
      $addToSet: {
        reportReasons: `${reason} (Analyse IA : ${aiResult.decision} - ${aiResult.reasoning} - Confiance : ${aiResult.confidence * 100}%)`,
      },
    });

    return {
      success: true,
      autoBanned: autoBanned,
      message: autoBanned
        ? 'Ce contenu a été temporairement masqué suite à une détection automatique de violation des règles.'
        : 'Votre signalement a bien été pris en compte et va être analysé.',
      aiAnalysis: {
        decision: aiResult.decision,
        confidence: aiResult.confidence,
        reason: aiResult.reasoning,
      },
    };
  }

  async clearReport(id: string, user: any) {
    if (!['Moderateur', 'Admin'].includes(user.role)) {
      throw new ForbiddenException('Permissions insuffisantes.');
    }
    await this.postModel.findByIdAndUpdate(id, {
      $set: { isReported: false, reportReasons: [] },
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
  }

  private async enrichPost(post: any, authorUser?: any) {
    const commentCount = await this.commentModel.countDocuments({
      post_id: post._id,
    });

    let authorPseudo = 'Anonyme';

    // N'afficher le pseudo que si isAnonymous est explicitement false
    if (post.isAnonymous === false || post.isAnonymous === 'false') {
      if (authorUser) {
        // Le user peut être un doc Mongoose ou un objet plain
        authorPseudo =
          authorUser.pseudo || authorUser?.toObject?.()?.pseudo || 'Inconnu';
      } else {
        try {
          const author = (await this.postModel.db
            .model('User')
            .findById(post.author_id)
            .select('pseudo')
            .lean()) as any;
          authorPseudo = author?.pseudo || 'Inconnu';
        } catch {
          authorPseudo = 'Inconnu';
        }
      }
    }

    return {
      _id: post._id.toString(),
      author_id: post.author_id.toString(),
      authorPseudo,
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
    };
  }
}
