import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppVersion, AppVersionDocument } from '../schemas/app-version.schema';
import { User, UserDocument } from '../schemas/user.schema';
import { AiService } from '../ai/ai.service';
import { FcmService } from '../common/fcm/fcm.service';

/** Compare deux chaînes semver : retourne true si a < b */
function semverLt(a: string, b: string): boolean {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return false;
  }
  return false;
}

@Injectable()
export class VersionsService {
  private readonly logger = new Logger(VersionsService.name);

  constructor(
    @InjectModel(AppVersion.name) private versionModel: Model<AppVersionDocument>,
    @InjectModel(User.name)       private userModel:    Model<UserDocument>,
    private readonly aiService:   AiService,
    private readonly fcmService:  FcmService,
  ) {}

  // ── Obtenir la config active (la plus récente) ──────────────────────────
  async getCurrent(): Promise<AppVersionDocument | null> {
    return this.versionModel.findOne().sort({ updatedAt: -1 }).lean() as any;
  }

  // ── Définir latestVersion + minSupportedVersion ─────────────────────────
  async setVersion(dto: {
    latestVersion: string;
    minSupportedVersion: string;
    downloadUrl?: string;
    releaseNotes?: string;
  }): Promise<AppVersionDocument> {
    // Upsert - on garde une seule doc de config
    const config = await this.versionModel.findOneAndUpdate(
      {},
      { ...dto, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    this.logger.log(`Version mise à jour → latest: ${dto.latestVersion}, min: ${dto.minSupportedVersion}`);
    return config;
  }

  // ── Vérification version côté mobile ────────────────────────────────────
  async checkVersion(currentVersion: string): Promise<{
    needsHardUpdate: boolean;
    needsSoftUpdate: boolean;
    latestVersion: string;
    minSupportedVersion: string;
    downloadUrl: string | null;
    releaseNotes: string | null;
  }> {
    const config = await this.getCurrent();
    if (!config) {
      // Aucune config → pas de mise à jour requise
      return {
        needsHardUpdate: false,
        needsSoftUpdate: false,
        latestVersion: currentVersion,
        minSupportedVersion: currentVersion,
        downloadUrl: null,
        releaseNotes: null,
      };
    }

    const needsHardUpdate = semverLt(currentVersion, config.minSupportedVersion);
    const needsSoftUpdate = !needsHardUpdate && semverLt(currentVersion, config.latestVersion);

    return {
      needsHardUpdate,
      needsSoftUpdate,
      latestVersion: config.latestVersion,
      minSupportedVersion: config.minSupportedVersion,
      downloadUrl: config.downloadUrl ?? null,
      releaseNotes: config.releaseNotes ?? null,
    };
  }

  // ── Mettre à jour appVersion + token FCM de l'utilisateur ───────────────
  async updateDeviceInfo(userId: string, appVersion: string, fcmToken?: string): Promise<void> {
    const update: any = { appVersion };
    if (fcmToken) {
      // On ajoute le token dans le tableau existant (multi-appareils)
      update.$addToSet = { token: fcmToken };
    }
    await this.userModel.findByIdAndUpdate(userId, update);
  }

  // ── Envoi manuel de notification ─────────────────────────────────────────
  async sendManualNotification(dto: {
    customMessage?: string;
    targetVersion?: string;
  }): Promise<{ notifiedCount: number; failedCount: number }> {
    const config = await this.getCurrent();
    if (!config) throw new NotFoundException('Aucune configuration de version définie.');

    const targetVer = dto.targetVersion || config.latestVersion;

    // Chercher les utilisateurs avec version obsolète ET un token FCM
    const users = await this.userModel
      .find({
        'token.0': { $exists: true },
        $or: [
          { appVersion: { $lt: targetVer } },
          { appVersion: null },
          { appVersion: { $exists: false } },
        ],
      })
      .select('_id token appVersion')
      .lean();

    if (users.length === 0) {
      return { notifiedCount: 0, failedCount: 0 };
    }

    // Générer le texte (IA ou message personnalisé)
    let title: string;
    let body: string;

    if (dto.customMessage && dto.customMessage.trim().length > 0) {
      title = '🔄 Mise à jour AlertProche';
      body  = dto.customMessage.trim();
    } else {
      const generated = await this.aiService.generateUpdateNotificationText();
      title = generated.title;
      body  = generated.body;
    }

    // Collecter tous les tokens uniques
    const allTokens = [...new Set(users.flatMap(u => u.token || []).filter(Boolean))];
    const result = await this.fcmService.sendBatchUpdateNotifications(allTokens, title, body);

    // Mettre à jour lastUpdateNotificationSentAt pour ces utilisateurs
    const userIds = users.map(u => u._id);
    await this.userModel.updateMany(
      { _id: { $in: userIds } },
      { $set: { lastUpdateNotificationSentAt: new Date() } },
    );

    // Nettoyer les tokens invalides
    if (result.invalidTokens.length > 0) {
      await this.userModel.updateMany(
        { token: { $in: result.invalidTokens } },
        { $pull: { token: { $in: result.invalidTokens } } },
      );
      this.logger.log(`🗑 ${result.invalidTokens.length} token(s) invalide(s) nettoyé(s).`);
    }

    return { notifiedCount: result.successCount, failedCount: result.failureCount };
  }

  // ── Méthode interne pour le cron ─────────────────────────────────────────
  async sendCronRelanceNotification(): Promise<void> {
    const config = await this.getCurrent();
    if (!config) {
      this.logger.warn('Cron version : aucune config de version, cron ignoré.');
      return;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const users = await this.userModel
      .find({
        'token.0': { $exists: true },
        $and: [
          {
            $or: [
              { appVersion: { $lt: config.latestVersion } },
              { appVersion: null },
              { appVersion: { $exists: false } },
            ],
          },
          {
            $or: [
              { lastUpdateNotificationSentAt: null },
              { lastUpdateNotificationSentAt: { $exists: false } },
              { lastUpdateNotificationSentAt: { $lte: sevenDaysAgo } },
            ],
          },
        ],
      })
      .select('_id token appVersion lastUpdateNotificationSentAt')
      .lean();

    if (users.length === 0) {
      this.logger.log('Cron version : aucun utilisateur à notifier.');
      return;
    }

    this.logger.log(`Cron version : ${users.length} utilisateur(s) à relancer.`);

    const { title, body } = await this.aiService.generateUpdateNotificationText();
    const allTokens = [...new Set(users.flatMap(u => u.token || []).filter(Boolean))];
    const result = await this.fcmService.sendBatchUpdateNotifications(allTokens, title, body);

    const userIds = users.map(u => u._id);
    await this.userModel.updateMany(
      { _id: { $in: userIds } },
      { $set: { lastUpdateNotificationSentAt: new Date() } },
    );

    if (result.invalidTokens.length > 0) {
      await this.userModel.updateMany(
        { token: { $in: result.invalidTokens } },
        { $pull: { token: { $in: result.invalidTokens } } },
      );
    }

    this.logger.log(`Cron version terminé : ${result.successCount} envois réussis.`);
  }
}
