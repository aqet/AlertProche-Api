import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PushService } from './push.service';
import { NotificationsModule } from '../../notifications/notifications.module';
import { User, UserSchema } from '../../schemas/user.schema';

@Module({
  imports: [
    NotificationsModule, // fournit WebPushService
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
