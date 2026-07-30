import { Controller, Post, Body } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('save-token')
  async saveToken(@Body() body: { userId: string; token: string }) {
    // Appel du service pour sauvegarder en base de données
    return this.notificationsService.sauvegarderToken(body.userId, body.token);
  }

  // Une route de test pour déclencher une notification manuellement
  @Post('test-envoi')
  async testEnvoi(@Body() body: { token: string; message: string }) {
    return this.notificationsService.envoyerNotification(body.token, 'Alerte !', body.message);
  }
}