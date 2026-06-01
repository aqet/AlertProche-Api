import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument, UserRole } from '../schemas/user.schema';
import { Post, PostDocument } from '../schemas/post.schema';
import { Comment, CommentDocument } from '../schemas/comment.schema';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name)    private userModel:    Model<UserDocument>,
    @InjectModel(Post.name)    private postModel:    Model<PostDocument>,
    @InjectModel(Comment.name) private commentModel: Model<CommentDocument>,
  ) {}

  // ─── STATISTIQUES GLOBALES ───────────────────────────────────────────────
  async getStats() {
    const [
      totalUsers,
      totalPosts,
      totalComments,
      reportedPosts,
      disabledPosts,
      disparitions,
      abus,
      prevention,
      usersStandard,
      usersMod,
      usersAdmin,
      recentPosts,
      recentUsers,
    ] = await Promise.all([
      this.userModel.countDocuments(),
      this.postModel.countDocuments(),
      this.commentModel.countDocuments(),
      this.postModel.countDocuments({ isReported: true }),
      this.postModel.countDocuments({ isActive: false }),
      this.postModel.countDocuments({ type: 'Disparition' }),
      this.postModel.countDocuments({ type: 'Abus' }),
      this.postModel.countDocuments({ type: 'Prevention' }),
      this.userModel.countDocuments({ role: 'Standard' }),
      this.userModel.countDocuments({ role: 'Moderateur' }),
      this.userModel.countDocuments({ role: 'Admin' }),
      // 7 derniers jours
      this.postModel.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
      }),
      this.userModel.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
      }),
    ]);

    // Activité par jour (30 derniers jours)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const activityByDay = await this.postModel.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return {
      users: { total: totalUsers, standard: usersStandard, moderateur: usersMod, admin: usersAdmin, newThisWeek: recentUsers },
      posts: { total: totalPosts, reported: reportedPosts, disabled: disabledPosts, disparitions, abus, prevention, newThisWeek: recentPosts },
      comments: { total: totalComments },
      activityByDay,
    };
  }

  // ─── GESTION UTILISATEURS ────────────────────────────────────────────────
  async getAllUsers(page = 1, limit = 20, search?: string): Promise<any> {
    const query: any = {};
    if (search) {
      query.$or = [
        { pseudo: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.userModel
        .find(query)
        .select('-password')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.userModel.countDocuments(query),
    ]);

    // Enrichir avec compteurs
    const enriched = await Promise.all(
      users.map(async (u) => {
        const [postCount, commentCount] = await Promise.all([
          this.postModel.countDocuments({ author_id: u._id }),
          this.commentModel.countDocuments({ author_id: u._id }),
        ]);
        return { ...u, _id: u._id.toString(), postCount, commentCount };
      }),
    );

    return { users: enriched, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async updateUserRole(userId: string, role: UserRole, requestingUser: any) {
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('Utilisateur introuvable.');
    if (userId === requestingUser._id.toString()) {
      throw new ForbiddenException('Vous ne pouvez pas modifier votre propre rôle.');
    }

    const user = await this.userModel
      .findByIdAndUpdate(userId, { role }, { new: true })
      .select('-password');
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  async deleteUser(userId: string, requestingUser: any) {
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('Utilisateur introuvable.');
    if (userId === requestingUser._id.toString()) {
      throw new ForbiddenException('Vous ne pouvez pas supprimer votre propre compte.');
    }

    const oid = new Types.ObjectId(userId);
    // Anonymiser les posts et commentaires
    await this.postModel.updateMany({ author_id: oid }, { $set: { isAnonymous: true, authorPseudo: 'Compte supprimé' } });
    await this.commentModel.updateMany({ author_id: oid }, { $set: { isAnonymous: true } });
    await this.userModel.findByIdAndDelete(userId);
  }

  // ─── GESTION POSTS (vue admin) ───────────────────────────────────────────
  async getAllPostsAdmin(page = 1, limit = 20, filter?: string): Promise<any> {
    const query: any = {};
    if (filter === 'reported') query.isReported = true;
    if (filter === 'disabled') query.isActive = false;

    const [posts, total] = await Promise.all([
      this.postModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.postModel.countDocuments(query),
    ]);

    const enriched = await Promise.all(
      posts.map(async (p) => {
        const [commentCount, author] = await Promise.all([
          this.commentModel.countDocuments({ post_id: p._id }),
          this.userModel.findById(p.author_id).select('pseudo email').lean(),
        ]);
        return {
          ...p,
          _id: p._id.toString(),
          author_id: p.author_id.toString(),
          authorPseudo: p.isAnonymous ? 'Anonyme' : ((author as any)?.pseudo || 'Inconnu'),
          authorEmail: (author as any)?.email || '',
          commentCount,
        };
      }),
    );

    return { posts: enriched, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async hardDeletePost(postId: string) {
    if (!Types.ObjectId.isValid(postId)) throw new NotFoundException('Publication introuvable.');
    await this.commentModel.deleteMany({ post_id: new Types.ObjectId(postId) });
    await this.postModel.findByIdAndDelete(postId);
  }
}
