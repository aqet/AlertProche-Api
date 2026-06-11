import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Comment, CommentDocument } from '../schemas/comment.schema';
import { Post, PostDocument } from '../schemas/post.schema';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ModerationService } from '../common/moderation/moderation.service';
import { AiService } from 'src/ai/ai.service';

@Injectable()
export class CommentsService {
  constructor(
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
    @InjectModel(Post.name) private postModel: Model<PostDocument>,
    private moderationService: ModerationService,
    private aiService: AiService,
  ) {}

  async findByPost(postId: string) {
    if (!Types.ObjectId.isValid(postId)) return [];

    const comments = await this.commentModel
      .find({ post_id: new Types.ObjectId(postId) })
      .sort({ createdAt: 1 })
      .lean();

    return Promise.all(comments.map((c) => this.enrichComment(c)));
  }

  async findMyComments(userId: string) {
    const comments = await this.commentModel
      .find({ author_id: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();

    return Promise.all(comments.map((c) => this.enrichComment(c)));
  }

  async create(postId: string, dto: CreateCommentDto, user: any) {
    if (!Types.ObjectId.isValid(postId))
      throw new NotFoundException('Publication introuvable.');

    const post = await this.postModel.findById(postId);
    if (!post) throw new NotFoundException('Publication introuvable.');
    if (!post.isActive)
      throw new ForbiddenException('Cette publication est désactivée.');

    // Modération

    let aiResult = this.aiService.moderateContent(dto.content);
    if ((await aiResult).decision == 'BAN' && (await aiResult).confidence >= 0.9 ) {
      return aiResult;
    } else {
      const comment = await this.commentModel.create({
        post_id: new Types.ObjectId(postId),
        author_id: new Types.ObjectId(user._id.toString()),
        content: dto.content,
        isAnonymous: dto.isAnonymous || false,
      });

      return this.enrichComment(comment.toObject(), user);
    }
    // this.moderationService.validateOrThrow(dto.content);

    // const comment = await this.commentModel.create({
    //   post_id: new Types.ObjectId(postId),
    //   author_id: new Types.ObjectId(user._id.toString()),
    //   content: dto.content,
    //   isAnonymous: dto.isAnonymous || false,
    // });

    // return this.enrichComment(comment.toObject(), user);
  }

  async remove(id: string, user: any) {
    if (!Types.ObjectId.isValid(id))
      throw new NotFoundException('Commentaire introuvable.');

    const comment = await this.commentModel.findById(id);
    if (!comment) throw new NotFoundException('Commentaire introuvable.');

    // Propriétaire ou Modérateur/Admin
    const isOwner = comment.author_id.toString() === user._id.toString();
    const canModerate = ['Moderateur', 'Admin'].includes(user.role);

    if (!isOwner && !canModerate) {
      throw new ForbiddenException(
        'Vous ne pouvez supprimer que vos propres commentaires.',
      );
    }

    await this.commentModel.findByIdAndDelete(id);
  }

  private async enrichComment(comment: any, authorUser?: any) {
    let authorPseudo = 'Anonyme';
    if (comment.isAnonymous === false || comment.isAnonymous === 'false') {
      if (authorUser) {
        authorPseudo = authorUser.pseudo || 'Inconnu';
      } else {
        try {
          const author = (await this.commentModel.db
            .model('User')
            .findById(comment.author_id)
            .select('pseudo')
            .lean()) as any;
          authorPseudo = author?.pseudo || 'Inconnu';
        } catch {
          authorPseudo = 'Inconnu';
        }
      }
    }

    return {
      _id: comment._id.toString(),
      post_id: comment.post_id.toString(),
      author_id: comment.author_id.toString(),
      authorPseudo,
      isAnonymous:
        comment.isAnonymous === true || comment.isAnonymous === 'true',
      content: comment.content,
      createdAt: comment.createdAt,
    };
  }
}
