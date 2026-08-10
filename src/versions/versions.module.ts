import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { AppVersion, AppVersionSchema } from '../schemas/app-version.schema';
import { User, UserSchema } from '../schemas/user.schema';
import { AiModule } from '../ai/ai.module';
import { FcmService } from '../common/fcm/fcm.service';
import { VersionsService } from './versions.service';
import { VersionNotificationCronService } from './version-cron.service';
import {
  VersionsPublicController,
  VersionsAdminController,
  DeviceInfoController,
} from './versions.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: AppVersion.name, schema: AppVersionSchema },
      { name: User.name,       schema: UserSchema },
    ]),
    AiModule,
  ],
  controllers: [
    VersionsPublicController,
    VersionsAdminController,
    DeviceInfoController,
  ],
  providers: [VersionsService, VersionNotificationCronService, FcmService],
  exports: [VersionsService],
})
export class VersionsModule {}
