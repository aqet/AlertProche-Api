import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '../schemas/user.schema';
import { Post, PostDocument } from '../schemas/post.schema';

/**
 * Règles de confiance (vote communautaire + réputation).
 *
 * Principes :
 * - Le vote de confirmation est PUBLIC et positif uniquement.
 *   On ne compte jamais de vote négatif public : une famille en deuil
 *   ne doit pas pouvoir être harcelée par un compteur de votes.
 * - La réputation NÉGATIVE (strikes) est PRIVÉE : elle n'est décidée
 *   que par la modération, jamais par un vote de foule.
 * - Un poids de vote n'est PAS transmis : 1 compte = 1 vote.
 *   Le seul endroit où la réputation compte, c'est l'attribution du
 *   badge « Confirmée par la communauté » (3 votes de comptes confirmés).
 */

/** Seuils de calcul du badge « Confirmée par la communauté ». */
export const TRUST_RULES = {
  /** Nombre de votes bruts minimum. */
  MIN_VOTES: 5,
  /** Nombre de votes minimum venant de comptes « Confirmés » (credibility >= 30). */
  MIN_TRUSTED_VOTES: 3,
  /** Nombre de vues minimum (évite « 5 votes sur 5 vues »). */
  MIN_VIEWS: 10,
  /** ancienneté de compte minimum (en heures) pour pouvoir voter. */
  MIN_ACCOUNT_AGE_HOURS: 24,
  /** ancienneté de compte (jours) avant le badge « Nouveau ». */
  NEW_ACCOUNT_DAYS: 7,
  /** score minimum pour le badge « Confirmé ». */
  CONFIRMED_SCORE: 30,
  /** score minimum pour le badge « Référence ». */
  REFERENCE_SCORE: 70,
  /** score requis pour qu'un vote compte comme « de confiance ». */
  TRUSTED_VOTER_SCORE: 30,
  /**
   * Plancher de crédibilité accordé au staff (Admin / Modérateur).
   * Ce sont des comptes vérifiés : ils servent d'amorçage au système
   * (« les anciens du village ») tant que la communauté n'a pas
   * encore produit ses propres comptes de confiance.
   */
  STAFF_CREDIBILITY_FLOOR: 70,
  /** points gagnés quand une alerte est cautionnée par la communauté. */
  POINTS_CONFIRMED_ALERT: 5,
  /** points gagnés quand une alerte est résolue. */
  POINTS_RESOLVED_ALERT: 5,
  /** points gagnés en confirmant l'alerte de quelqu'un d'autre. */
  POINTS_CONFIRM_VOTE: 1,
  /**
   * Plafond total de points gagnables via les votes de confirmation.
   * Évite qu'un compte gonfle sa réputation en votant machinalement.
   */
  MAX_POINTS_FROM_VOTES: 20,
  /** points perdus quand une alerte est jugée fausse. */
  POINTS_STRIKE: 10,
  /** nombre de signalements distincts déclenchant « En vérification ». */
  REVIEW_THRESHOLD: 3,
  /** nombre d'avertissements bloquant la publication. */
  STRIKES_BLOCK: 3,
} as const;

export type TrustBadge = 'none' | 'new' | 'confirmed' | 'reference';

@Injectable()
export class TrustService {
  private readonly logger = new Logger(TrustService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Post.name) private readonly postModel: Model<PostDocument>,
  ) {}

  /* ── Badges publics ───────────────────────────────────────────── */

  /**
   * Crédibilité réellement prise en compte dans les calculs.
   *
   * Le staff (Admin / Modérateur) est traité comme un compte de confiance
   * même si son score stocké est bas : sans ce plancher, personne ne
   * pourrait jamais atteindre le seuil de 30 au lancement, donc aucune
   * alerte ne serait jamais « confirmée par la communauté ».
   */
  effectiveCredibility(user: {
    credibility?: number;
    role?: string;
    strikes?: number;
  }): number {
    const score = user.credibility ?? 0;
    const isStaff = user.role === 'Admin' || user.role === 'Moderateur';
    // Un membre du staff sanctionné perd ce privilège.
    if (isStaff && (user.strikes ?? 0) === 0) {
      return Math.max(score, TRUST_RULES.STAFF_CREDIBILITY_FLOOR);
    }
    return score;
  }

  /** Badge de confiance d'un compte (jamais de score brut affiché). */
  getBadge(user: {
    credibility?: number;
    createdAt?: Date | string;
    role?: string;
    strikes?: number;
  }): TrustBadge {
    const credibility = this.effectiveCredibility(user);
    if (credibility >= TRUST_RULES.REFERENCE_SCORE) return 'reference';
    if (credibility >= TRUST_RULES.CONFIRMED_SCORE) return 'confirmed';

    const createdAt = user.createdAt ? new Date(user.createdAt) : null;
    if (createdAt) {
      const days = (Date.now() - createdAt.getTime()) / 86_400_000;
      if (days < TRUST_RULES.NEW_ACCOUNT_DAYS) return 'new';
    }
    return 'none';
  }

  /* ── Calculs de vote ──────────────────────────────────────────── */

  /**
   * Calcule l'état de confiance d'un ensemble d'alertes.
   * Une seule requête Users pour tous les votants (évite le N+1).
   */
  async computeTrustForPosts(posts: any[]): Promise<void> {
    if (!posts?.length) return;

    // 1) Rassembler tous les votants de tous les posts
    const allVoterIds = new Set<string>();
    for (const post of posts) {
      for (const id of post.trustVotes ?? []) allVoterIds.add(String(id));
    }

    // 2) Charger leur réputation en une seule requête
    const voterScores = new Map<string, number>();
    if (allVoterIds.size > 0) {
      const voters = await this.userModel
        .find({ _id: { $in: [...allVoterIds] } })
        .select('_id credibility role strikes')
        .lean();

      for (const v of voters as any[]) {
        voterScores.set(String(v._id), this.effectiveCredibility(v));
      }
    }

    // 3) Annoter chaque post
    for (const post of posts) {
      const votes: string[] = post.trustVotes ?? [];
      const trustedVotes = votes.filter(
        (id) => (voterScores.get(String(id)) ?? 0) >= TRUST_RULES.TRUSTED_VOTER_SCORE,
      ).length;

      const views = post.viewsCount ?? 0;

      post.trustVoteCount = votes.length;
      post.trustedVoteCount = trustedVotes;
      post.communityConfirmed =
        votes.length >= TRUST_RULES.MIN_VOTES &&
        trustedVotes >= TRUST_RULES.MIN_TRUSTED_VOTES &&
        views >= TRUST_RULES.MIN_VIEWS;
      post.reportCount = (post.reportedBy ?? []).length;
      post.underReview = post.reportCount >= TRUST_RULES.REVIEW_THRESHOLD;
    }
  }

  /* ── Réputation ───────────────────────────────────────────────── */

  /** Ajoute des points de confiance à un compte (plafond 100, plancher 0). */
  async addCredibility(userId: string, points: number): Promise<void> {
    await this.userModel.updateOne({ _id: userId }, { $inc: { credibility: points } });
    // Bornage : on ne peut pas cumuler $inc et $max sur le même chemin.
    await this.userModel.updateOne(
      { _id: userId, credibility: { $lt: 0 } },
      { $set: { credibility: 0 } },
    );
    await this.userModel.updateOne(
      { _id: userId, credibility: { $gt: 100 } },
      { $set: { credibility: 100 } },
    );
  }

  /**
   * Récompense un vote de confirmation donné à l'alerte de quelqu'un d'autre.
   *
   * C'est l'amorçage « par la participation » : sans lui, un nouveau compte
   * resterait bloqué à 0 et ne pourrait jamais devenir un votant de confiance.
   * Garde-fous : 1 point par jour maximum et 20 points au total via les votes.
   *
   * Retirer son vote ne reprend pas le point : la participation a bien eu
   * lieu, et le plafond journalier empêche d'en faire une machine à points.
   */
  async rewardConfirmationVote(userId: string): Promise<void> {
    const user: any = await this.userModel
      .findById(userId)
      .select('voteCredibilityPoints lastVotePointAt')
      .lean();
    if (!user) return;

    const earned = user.voteCredibilityPoints ?? 0;
    if (earned >= TRUST_RULES.MAX_POINTS_FROM_VOTES) return;

    const now = new Date();
    const last = user.lastVotePointAt ? new Date(user.lastVotePointAt) : null;
    if (last && last.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
      return;
    }

    const points = TRUST_RULES.POINTS_CONFIRM_VOTE;
    await this.userModel.updateOne(
      { _id: userId },
      {
        $inc: { credibility: points, voteCredibilityPoints: points },
        $set: { lastVotePointAt: now },
      },
    );
    await this.userModel.updateOne(
      { _id: userId, credibility: { $gt: 100 } },
      { $set: { credibility: 100 } },
    );
  }

  /** Incrémente un compteur d'alertes cautionnées / résolues. */
  async incrementCounter(userId: string, field: 'confirmedAlerts' | 'resolvedAlerts'): Promise<void> {
    await this.userModel.updateOne({ _id: userId }, { $inc: { [field]: 1 } });
  }

  /**
   * Applique un avertissement (alerte confirmée fausse par la modération).
   * C'est le SEUL chemin vers la réputation négative.
   */
  async applyStrike(userId: string, reason: string): Promise<void> {
    const user = await this.userModel.findById(userId);
    if (!user) return;

    const strikes = (user.strikes ?? 0) + 1;
    const credibility = Math.max(0, (user.credibility ?? 0) - TRUST_RULES.POINTS_STRIKE);

    await this.userModel.updateOne(
      { _id: userId },
      {
        $set: {
          strikes,
          credibility,
          lastStrikeAt: new Date(),
        },
        $push: { strikeReasons: reason.slice(0, 200) },
      },
    );

    this.logger.warn(`Avertissement appliqué à l'utilisateur ${userId} : ${reason}`);
  }

  /** Retire un avertissement (erreur du staff). */
  async removeStrike(userId: string): Promise<void> {
    const user = await this.userModel.findById(userId);
    if (!user) return;

    const strikes = Math.max(0, (user.strikes ?? 0) - 1);
    const credibility = Math.min(100, (user.credibility ?? 0) + TRUST_RULES.POINTS_STRIKE);

    await this.userModel.updateOne(
      { _id: userId },
      { $set: { strikes, credibility }, $pop: { strikeReasons: 1 } },
    );
  }

  /** Un compte peut-il publier ? (blocage après 3 avertissements) */
  async canPublish(userId: string): Promise<boolean> {
    const user = await this.userModel.findById(userId).select('strikes role').lean();
    if (!user) return true;
    if (user.role === 'Admin' || user.role === 'Moderateur') return true;
    return (user.strikes ?? 0) < TRUST_RULES.STRIKES_BLOCK;
  }
}
