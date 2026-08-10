import {
  Controller, Get, Post, Body, Query,
  UseGuards, Req, HttpCode, HttpStatus,
} from '@nestjs/common';
import { IsString, IsOptional, Matches } from 'class-validator';
import { VersionsService } from './versions.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

// ── DTOs ───────────────────────────────────────────────────────────────────

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

export class SetVersionDto {
  @IsString()
  @Matches(SEMVER_REGEX, { message: 'latestVersion doit être au format X.Y.Z' })
  latestVersion: string;

  @IsString()
  @Matches(SEMVER_REGEX, { message: 'minSupportedVersion doit être au format X.Y.Z' })
  minSupportedVersion: string;

  @IsOptional() @IsString()
  downloadUrl?: string;

  @IsOptional() @IsString()
  releaseNotes?: string;
}

export class SendNotificationDto {
  @IsOptional() @IsString()
  customMessage?: string;

  @IsOptional() @IsString()
  @Matches(SEMVER_REGEX, { message: 'targetVersion doit être au format X.Y.Z' })
  targetVersion?: string;
}

export class UpdateDeviceInfoDto {
  @IsString()
  @Matches(SEMVER_REGEX, { message: 'appVersion doit être au format X.Y.Z' })
  appVersion: string;

  @IsOptional() @IsString()
  fcmToken?: string;
}

// ── Controllers ───────────────────────────────────────────────────────────

/** Endpoint public - vérification de version (pas besoin d'être connecté) */
@Controller('versions')
export class VersionsPublicController {
  constructor(private readonly versionsService: VersionsService) {}

  /** GET /versions/check?currentVersion=X.Y.Z */
  @Get('check')
  checkVersion(@Query('currentVersion') currentVersion: string) {
    return this.versionsService.checkVersion(currentVersion || '0.0.0');
  }
}

/** Endpoint admin - gestion des versions */
@Controller('admin/versions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('Admin')
export class VersionsAdminController {
  constructor(private readonly versionsService: VersionsService) {}

  /** GET /admin/versions - Config actuelle */
  @Get()
  getCurrent() {
    return this.versionsService.getCurrent();
  }

  /** POST /admin/versions - Définir latestVersion + minSupportedVersion */
  @Post()
  setVersion(@Body() dto: SetVersionDto) {
    return this.versionsService.setVersion(dto);
  }

  /** POST /admin/versions/notify - Envoi manuel */
  @Post('notify')
  @HttpCode(HttpStatus.OK)
  sendNotification(@Body() dto: SendNotificationDto) {
    return this.versionsService.sendManualNotification(dto);
  }
}

/** Endpoint authentifié - mise à jour device info utilisateur */
@Controller('users')
@UseGuards(JwtAuthGuard)
export class DeviceInfoController {
  constructor(private readonly versionsService: VersionsService) {}

  /** POST /users/device-info */
  @Post('device-info')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateDeviceInfo(@Body() dto: UpdateDeviceInfoDto, @Req() req: any) {
    return this.versionsService.updateDeviceInfo(
      req.user._id.toString(),
      dto.appVersion,
      dto.fcmToken,
    );
  }
}
