import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SosController } from './sos.controller';
import { SosService } from './sos.service';
import { SosAlert, SosAlertSchema } from './sos-alert.schema';
import { TrustedContactsController } from './trusted-contacts.controller';
import { TrustedContactsService } from './trusted-contacts.service';
import { User, UserSchema } from '../schemas/user.schema';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SosAlert.name, schema: SosAlertSchema },
      { name: User.name,     schema: UserSchema },
    ]),
    NotificationsModule,
  ],
  controllers: [SosController, TrustedContactsController],
  providers:   [SosService, TrustedContactsService],
  exports:     [SosService, TrustedContactsService],
})
export class SosModule {}
