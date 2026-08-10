import {
  Controller, Post, Patch, Get, Body, Param, Query,
  HttpCode, HttpStatus, Req, UseGuards
} from '@nestjs/common';
import { Request } from 'express';
import { TrackingService } from './tracking.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EndSessionDto } from './dto/end-session.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  // ── Endpoints de collecte (pas de JWT - accessibles à tous) ──────

  // Répond 202 immédiatement, persiste en arrière-plan
  @Post('session')
  @HttpCode(HttpStatus.ACCEPTED)
  createSession(@Body() dto: CreateSessionDto, @Req() req: Request) {
    this.trackingService.persistSession(dto, req).catch(() => {});
    return;
  }

  @Post('pageview')
  @HttpCode(HttpStatus.ACCEPTED)
  createPageview(@Body() dto: CreateEventDto) {
    this.trackingService.persistPageview(dto).catch(() => {});
    return;
  }

  @Post('event')
  @HttpCode(HttpStatus.ACCEPTED)
  createEvent(@Body() dto: CreateEventDto) {
    this.trackingService.persistEvent(dto).catch(() => {});
    return;
  }

  @Patch('session/:sessionId/end')
  @HttpCode(HttpStatus.ACCEPTED)
  endSession(@Param('sessionId') sessionId: string, @Body() dto: EndSessionDto) {
    this.trackingService.endSession(sessionId, dto).catch(() => {});
    return;
  }

  // ── Endpoints analytics (JWT + rôle Admin) ───────────────────────

  @Get('analytics/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getOverview(@Query('period') period = '30d') {
    return this.trackingService.getOverview(period);
  }

  @Get('analytics/pages')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getPages(@Query('period') period = '30d') {
    return this.trackingService.getTopPages(period);
  }

  @Get('analytics/geo')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getGeo(@Query('period') period = '30d') {
    return this.trackingService.getGeo(period);
  }

  @Get('analytics/devices')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getDevices(@Query('period') period = '30d') {
    return this.trackingService.getDevices(period);
  }

  @Get('analytics/sources')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getSources(@Query('period') period = '30d') {
    return this.trackingService.getSources(period);
  }

  @Get('analytics/activity')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getActivity(@Query('period') period = '30d') {
    return this.trackingService.getActivity(period);
  }

  @Get('analytics/top-posts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Admin')
  getTopPosts(@Query('period') period = '30d') {
    return this.trackingService.getTopPosts(period);
  }
}
