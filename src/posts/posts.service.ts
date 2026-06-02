import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post, PostDocument } from '../schemas/post.schema';
import { Comment, CommentDocument } from '../schemas/comment.schema';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { ModerationService } from '../common/moderation/moderation.service';

@Injectable()
export class PostsService {
  constructor(
    @InjectModel(Post.name) private postModel: Model<PostDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    private moderationService: ModerationService,
  ) {}

  async findAll(filters?: { type?: string; location?: string }) {
    const query: any = {};
    if (filters?.type) query.type = filters.type;
    if (filters?.location) query.location = { $regex: filters.location, $options: 'i' };

    const posts = await this.postModel
      .find(query)
      .sort({ createdAt: -1 })
      .lean();

    // Enrichir avec pseudo auteur et compteur commentaires
    return Promise.all(posts.map(p => this.enrichPost(p)));
  }

  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id).lean();
    if (!post) throw new NotFoundException('Publication introuvable.');
    return this.enrichPost(post);
  }

  async findMyPosts(userId: string) {
    const posts = await this.postModel
      .find({ author_id: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
    return Promise.all(posts.map(p => this.enrichPost(p)));
  }

  async findReported() {
    const posts = await this.postModel
      .find({ isReported: true })
      .sort({ createdAt: -1 })
      .lean();
    return Promise.all(posts.map(p => this.enrichPost(p)));
  }

  async create(dto: CreatePostDto, user: any, imageUrl?: string) {
    // Modération
    this.moderationService.validateOrThrow(dto.title);
    this.moderationService.validateOrThrow(dto.content);
    console.log(dto.isAnonymous);
    
    const post = await this.postModel.create({
      author_id: new Types.ObjectId(user._id.toString()),
      title: dto.title,
      content: dto.content,
      location: dto.location,
      type: dto.type,
      isAnonymous: false,
      image_url: imageUrl || null,
      isActive: true,
    });

    return this.enrichPost(post.toObject(), user);
  }

  async update(id: string, dto: UpdatePostDto, user: any) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    // Vérifier propriété (sauf Admin/Modérateur)
    if (user.role === 'Standard' && post.author_id.toString() !== user._id.toString()) {
      throw new ForbiddenException('Vous ne pouvez modifier que vos propres publications.');
    }

    if (dto.title) this.moderationService.validateOrThrow(dto.title);
    if (dto.content) this.moderationService.validateOrThrow(dto.content);

    const updated = await this.postModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .lean();

    return this.enrichPost(updated!);
  }

  async toggleActive(id: string, user: any) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    if (!['Moderateur', 'Admin'].includes(user.role)) {
      throw new ForbiddenException('Permissions insuffisantes.');
    }

    const updated = await this.postModel
      .findByIdAndUpdate(id, { $set: { isActive: !post.isActive } }, { new: true })
      .lean();

    return this.enrichPost(updated!);
  }

  async report(id: string, reason: string) {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    await this.postModel.findByIdAndUpdate(id, {
      $set: { isReported: true },
      $addToSet: { reportReasons: reason },
    });
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
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Publication introuvable.');
    const post = await this.postModel.findById(id);
    if (!post) throw new NotFoundException('Publication introuvable.');

    if (user.role === 'Standard' && post.author_id.toString() !== user._id.toString()) {
      throw new ForbiddenException('Vous ne pouvez supprimer que vos propres publications.');
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
        authorPseudo = authorUser.pseudo || authorUser?.toObject?.()?.pseudo || 'Inconnu';
      } else {
        try {
          const author = await this.postModel.db
            .model('User')
            .findById(post.author_id)
            .select('pseudo')
            .lean() as any;
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
