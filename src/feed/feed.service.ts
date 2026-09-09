import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FeedPost, FeedPostDocument } from './feed-post.schema';
import { CreateFeedPostDto } from './dto/create-feed-post.dto';
import { CloudinaryService } from '../common/cloudinary/cloudinary.service';
import { User, UserDocument } from '../schemas/user.schema';

@Injectable()
export class FeedService {
  private readonly logger = new Logger(FeedService.name);

  constructor(
    @InjectModel(FeedPost.name) private feedModel: Model<FeedPostDocument>,
    @InjectModel(User.name)     private userModel:  Model<UserDocument>,
    private readonly cloudinary: CloudinaryService,
  ) {}

  /** Récupérer le feed paginé avec la photoUrl à jour de chaque auteur */
  async getFeed(page = 1, limit = 10): Promise<{
    posts: any[];
    total: number;
    page: number;
    totalPages: number;
    hasMore: boolean;
  }> {
    const skip      = (page - 1) * limit;
    const safeLimit = Math.min(limit, 50);

    const [result, total] = await Promise.all([
      this.feedModel.aggregate([
        { $match: { isVisible: true } },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: safeLimit },
        // Jointure pour récupérer la photoUrl actuelle de l'auteur
        {
          $lookup: {
            from:         'users',
            localField:   'author.userId',
            foreignField: '_id',
            as:           '_authorDoc',
          },
        },
        {
          $addFields: {
            'author.photoUrl': {
              $ifNull: [
                { $arrayElemAt: ['$_authorDoc.photoUrl', 0] },
                '$author.photoUrl',  // fallback sur la valeur stockée
              ],
            },
          },
        },
        { $unset: '_authorDoc' },
      ]),
      this.feedModel.countDocuments({ isVisible: true }),
    ]);

    const totalPages = Math.ceil(total / safeLimit);

    return {
      posts: result,
      total,
      page,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  /** Créer un post (avec ou sans médias) — upload atomique */
  async createPost(
    dto: CreateFeedPostDto,
    user: { _id: string; pseudo: string; photoUrl?: string },
    files: Express.Multer.File[],
  ): Promise<FeedPostDocument> {
    // Valider : contenu OU média obligatoire
    if (!dto.content?.trim() && files.length === 0) {
      throw new BadRequestException('Un post doit contenir du texte ou un média.');
    }

    // 1. Créer le post en base SANS médias d'abord
    const post = await this.feedModel.create({
      author: {
        userId: new Types.ObjectId(user._id),
        pseudo: user.pseudo,
        photoUrl: user.photoUrl || null,
      },
      content: dto.content?.trim() || '',
      mediaType: 'none',
      mediaUrls: [],
      location: dto.location?.trim() || null,
      likesCount: 0,
      commentsCount: 0,
      sharesCount: 0,
      likedBy: [],
    });

    // 2. Si des fichiers sont fournis, uploader sur Cloudinary
    if (files.length > 0) {
      const uploadedUrls: string[]      = [];
      const uploadedFileTypes: string[] = [];
      const cloudinaryAssets: { publicId: string; resourceType: 'image' | 'video' }[] = [];

      try {
        for (const file of files) {
          const fileType: 'image' | 'video' = file.mimetype.startsWith('video/') ? 'video' : 'image';
          const result = await this.cloudinary.uploadFeedMedia(file.buffer, file.originalname, fileType);
          uploadedUrls.push(result.url);
          uploadedFileTypes.push(fileType);
          cloudinaryAssets.push({ publicId: result.publicId, resourceType: result.resourceType });
        }

        // Déterminer le mediaType global
        const hasImages = uploadedFileTypes.includes('image');
        const hasVideos = uploadedFileTypes.includes('video');
        const mediaType: 'image' | 'video' | 'mixed' =
          hasImages && hasVideos ? 'mixed' :
          hasVideos ? 'video' : 'image';

        // 3. Mise à jour atomique du post avec les URLs et métadonnées
        await this.feedModel.findByIdAndUpdate(post._id, {
          $set: {
            mediaType,
            mediaUrls:        uploadedUrls,
            mediaFileTypes:   uploadedFileTypes,
            cloudinaryAssets,
          },
        });

        post.mediaType = mediaType;
        post.mediaUrls = uploadedUrls;
        (post as any).cloudinaryAssets = cloudinaryAssets;
      } catch (err: any) {
        this.logger.error('Erreur upload Cloudinary feed:', err?.message);

        // 4. Rollback : supprimer le post et les assets déjà uploadés
        await this.feedModel.findByIdAndDelete(post._id).catch(() => {});
        for (const asset of cloudinaryAssets) {
          await this.cloudinary.deleteAsset(asset.publicId, asset.resourceType).catch(() => {});
        }

        throw new BadRequestException('Erreur lors de l\'upload du média. Réessayez.');
      }
    }

    return post;
  }

  /** Liker / Unliker un post — opérateurs atomiques MongoDB */
  async toggleLike(postId: string, userId: string): Promise<{ liked: boolean; likesCount: number }> {
    // Utiliser .lean() pour lire l'état actuel
    const post = await this.feedModel.findById(postId).lean();
    if (!post || !post.isVisible) throw new NotFoundException('Post introuvable.');

    // Comparaison robuste en strings pour gérer ObjectId ou string dans likedBy
    const alreadyLiked = post.likedBy.some((id) => id.toString() === userId);

    if (alreadyLiked) {
      await this.feedModel.findByIdAndUpdate(postId, {
        $pull: { likedBy: new Types.ObjectId(userId) },
        $inc: { likesCount: -1 },
      });
    } else {
      await this.feedModel.findByIdAndUpdate(postId, {
        $addToSet: { likedBy: new Types.ObjectId(userId) },
        $inc: { likesCount: 1 },
      });
    }

    // Relire le doc pour retourner le vrai count
    const updated = await this.feedModel.findById(postId).lean();
    return { liked: !alreadyLiked, likesCount: Math.max(0, updated?.likesCount ?? 0) };
  }

  /** Incrémenter le compteur de partages */
  async incrementShares(postId: string): Promise<void> {
    await this.feedModel.findByIdAndUpdate(postId, { $inc: { sharesCount: 1 } });
  }

  /** Récupérer les commentaires d'un post */
  async getComments(postId: string): Promise<any[]> {
    const post = await this.feedModel.findById(postId).lean();
    if (!post) throw new NotFoundException('Post introuvable.');
    return post.comments ?? [];
  }

  /** Ajouter un commentaire au post du feed */
  async addFeedComment(
    postId: string,
    userId: string,
    userPseudo: string,
    userPhotoUrl: string | null,
    content: string,
  ): Promise<any> {
    const comment = {
      _id:       new Types.ObjectId(),
      userId:    new Types.ObjectId(userId),
      pseudo:    userPseudo,
      photoUrl:  userPhotoUrl,
      content,
      createdAt: new Date(),
    };

    await this.feedModel.findByIdAndUpdate(postId, {
      $push: { comments: comment },
      $inc:  { commentsCount: 1 },
    });

    return comment;
  }

  /** Supprimer un post (auteur ou admin) */
  async deletePost(postId: string, userId: string, userRole: string): Promise<void> {
    const post = await this.feedModel.findById(postId);
    if (!post) throw new NotFoundException('Post introuvable.');

    const isOwner = post.author.userId.toString() === userId;
    const isAdmin = userRole === 'Admin' || userRole === 'Moderateur';

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Vous ne pouvez pas supprimer ce post.');
    }

    // Supprimer les médias Cloudinary avec les métadonnées exactes si disponibles
    const assets = (post as any).cloudinaryAssets as { publicId: string; resourceType: 'image' | 'video' }[] | undefined;

    if (assets && assets.length > 0) {
      // Cas idéal : on a les métadonnées exactes stockées à l'upload
      for (const asset of assets) {
        await this.cloudinary.deleteAsset(asset.publicId, asset.resourceType).catch(() => {});
      }
    } else {
      // Fallback pour anciens posts : deleteByUrl avec détection par URL
      for (const url of post.mediaUrls) {
        await this.cloudinary.deleteByUrl(url).catch(() => {});
      }
    }

    await this.feedModel.findByIdAndDelete(postId);
  }

  /** Incrémenter le compteur de commentaires */
  async incrementComments(postId: string, delta: 1 | -1): Promise<void> {
    await this.feedModel.findByIdAndUpdate(postId, {
      $inc: { commentsCount: delta },
    });
  }
}
