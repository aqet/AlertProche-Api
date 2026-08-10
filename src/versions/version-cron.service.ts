import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { VersionsService } from './versions.service';

@Injectable()
export class VersionNotificationCronService {
  private readonly logger = new Logger(VersionNotificationCronService.name);

  constructor(private readonly versionsService: VersionsService) {}

  /**
   * S'exécute toutes les 2 semaines à 10h00.
   * Relance les utilisateurs dont la version est obsolète
   * et qui n'ont pas reçu de notification depuis plus de 7 jours.
   */
  @Cron('0 10 */14 * *')
  async handleVersionRelance(): Promise<void> {
    this.logger.log('🕐 Cron version - Démarrage de la relance de mise à jour...');
    try {
      await this.versionsService.sendCronRelanceNotification();
    } catch (err: any) {
      this.logger.error('Cron version - Erreur :', err?.message);
    }
  }
}
