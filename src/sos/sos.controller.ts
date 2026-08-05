import {
  Controller, Post, Get, Body, Req,
  UseGuards, HttpCode, HttpStatus, Param,
} from '@nestjs/common';import { IsString, IsNumber, IsOptional, IsIn } from 'class-validator';
import { SosService } from './sos.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

class TriggerSosDto {
  @IsNumber() latitude: number;
  @IsNumber() longitude: number;
  @IsOptional() @IsString() voiceTranscription?: string;
  @IsOptional() @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) threatLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  @IsOptional() @IsString() audioUrl?: string;
}

class CancelSosDto {
  @IsString() sosId: string;
  @IsOptional() @IsString() reason?: string;
}

class ResolveSosDto {
  @IsString() sosId: string;
  @IsOptional() @IsString() reason?: string;
}

class UpdateLocationDto {
  @IsString() sosId: string;
  @IsNumber() latitude: number;
  @IsNumber() longitude: number;
}

class LowBatteryDto {
  @IsString() sosId: string;
}

@Controller('sos')
@UseGuards(JwtAuthGuard)
export class SosController {
  constructor(private readonly sosService: SosService) {}

  /** POST /sos/trigger — Déclencher un SOS */
  @Post('trigger')
  @HttpCode(HttpStatus.CREATED)
  trigger(@Body() dto: TriggerSosDto, @Req() req: any) {
    return this.sosService.trigger(
      req.user._id.toString(),
      dto.latitude,
      dto.longitude,
      dto.voiceTranscription,
      dto.threatLevel,
      dto.audioUrl,
    );
  }

  /** POST /sos/cancel — Annuler un SOS (émetteur) */
  @Post('cancel')
  cancel(@Body() dto: CancelSosDto, @Req() req: any) {
    return this.sosService.cancel(req.user._id.toString(), dto.sosId, dto.reason);
  }

  /** POST /sos/resolve — Résoudre un SOS (émetteur ou personne de confiance) */
  @Post('resolve')
  resolve(@Body() dto: ResolveSosDto, @Req() req: any) {
    return this.sosService.resolve(req.user._id.toString(), dto.sosId, dto.reason);
  }

  /** POST /sos/update-location — Mise à jour GPS (WebSocket de secours) */
  @Post('update-location')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateLocation(@Body() dto: UpdateLocationDto, @Req() req: any) {
    return this.sosService.updateLocation(
      req.user._id.toString(),
      dto.sosId,
      dto.latitude,
      dto.longitude,
    );
  }

  /** POST /sos/respond/:sosId — "J'arrive" (personne de confiance) */
  @Post('respond/:sosId')
  respond(@Param('sosId') sosId: string, @Req() req: any) {
    return this.sosService.confirmResponse(req.user._id.toString(), sosId);
  }

  /** POST /sos/low-battery — Alerte batterie critique */
  @Post('low-battery')
  @HttpCode(HttpStatus.NO_CONTENT)
  lowBattery(@Body() dto: LowBatteryDto, @Req() req: any) {
    return this.sosService.handleLowBattery(req.user._id.toString(), dto.sosId);
  }

  /** SOS actif de l'utilisateur connecté */
  @Get('active')
  getActive(@Req() req: any) {
    return this.sosService.getActiveSos(req.user._id.toString());
  }

  /** GET /sos/:sosId/status — Statut d'un SOS (pour polling côté émetteur et contact) */
  @Get(':sosId/status')
  getSosStatus(@Param('sosId') sosId: string, @Req() req: any) {
    return this.sosService.getSosStatus(req.user._id.toString(), sosId);
  }

  /** GET /sos/history — Historique des SOS */
  @Get('history')
  getHistory(@Req() req: any) {
    return this.sosService.getHistory(req.user._id.toString());
  }
}
