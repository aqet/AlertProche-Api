import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { WebPushService } from './web-push.service';
import { MongooseModule } from '@nestjs/mongoose';
import { Notification, NotificationSchema } from 'src/schemas/notification.schema';

@Module({
  controllers: [],
  providers: [NotificationsService, WebPushService],
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema }
    ])
  ],
  exports: [NotificationsService, WebPushService]
})
export class NotificationsModule {}
