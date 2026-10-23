import {
  Controller, Post, Patch, Get, Body, Param, Query,
  HttpCode, HttpStatus, Req, UseGuards
} from '@nestjs/common';
import { Request } from 'express';
import { TrackingService } from './tracking.service';
import { AnalyticsService } from './analytics.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EndSessionDto } from './dto/end-session.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('tracking')
export class TrackingController {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ── Endpoints de collecte (pas de JWT - accessibles à tous) ──────
  //
  // On attend la persistance avant de répondre : sur Vercel, une promesse
  // lancée « en arrière-plan » peut être tuée avec l'instance, ce qui faisait
  // perdre des sessions et faussait les statistiques.

  @Post('session')
  @HttpCode(HttpStatus.ACCEPTED)
  async createSession(@Body() dto: CreateSessionDto, @Req() req: Request) {
    try {
      await this.trackingService.persistSession(dto, req);
    } catch {
      // Le tracking ne doit jamais casser l'expérience utilisateur.
    }
  }

  @Post('pageview')
  @HttpCode(HttpStatus.ACCEPTED)
  async createPageview(@Body() dto: CreateEventDto) {
    try {
      await this.trackingService.persistPageview(dto);
    } catch {
      // silencieux
    }
  }

  @Post('event')
  @HttpCode(HttpStatus.ACCEPTED)
  async createEvent(@Body() dto: CreateEventDto) {
    try {
      await this.trackingService.persistEvent(dto);
    } catch {
      // silencieux
    }
  }

  @Patch('session/:sessionId/end')
  @HttpCode(HttpStatus.ACCEPTED)
  async endSession(@Param('sessionId') sessionId: string, @Body() dto: EndSessionDto) {
    try {
      await this.trackingService.endSession(sessionId, dto);
    } catch {
      // silencieux
    }
  }

  // ── Endpoints analytics (JWT + rôle Admin) ───────────────────────

  @Get('analytics/audience')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getAudience(@Query('period') period = '30d') {
    return this.analytics.getAudience(period);
  }

  @Get('analytics/mission')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getMission(@Query('period') period = '30d') {
    return this.analytics.getMission(period);
  }
}
