import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';

import { TrackingSession, TrackingSessionDocument } from './schemas/tracking-session.schema';
import { TrackingEvent, TrackingEventDocument } from './schemas/tracking-event.schema';
import { CreateSessionDto } from './dto/create-session.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EndSessionDto } from './dto/end-session.dto';
import { GeoService } from './geo.service';

const BOT_PATTERN =
  /bot|crawl|spider|slurp|headless|phantom|selenium|puppeteer|playwright|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|axios/i;

@Injectable()
export class TrackingService {
  constructor(
    @InjectModel(TrackingSession.name)
    private readonly sessionModel: Model<TrackingSessionDocument>,
    @InjectModel(TrackingEvent.name)
    private readonly eventModel: Model<TrackingEventDocument>,
    private readonly geo: GeoService,
  ) {}

  // ──────────────────────────────────────────────
  // Hachage IP
  // SHA-256 puis on garde les 16 premiers chars hex :
  // suffisant pour dé-duplication sans révéler l'IP réelle.
  // ──────────────────────────────────────────────
  hashIp(ip: string): string {
    return createHash('sha256').update(ip).digest('hex').slice(0, 16);
  }

  // ──────────────────────────────────────────────
  // Extraction de l'IP réelle
  // X-Forwarded-For peut contenir "clientIp, proxy1, proxy2" ;
  // on prend le premier élément (l'IP d'origine).
  // Le préfixe ::ffff: indique une IPv4 encapsulée en IPv6.
  // ──────────────────────────────────────────────
  extractIp(req: any): string {
    const forwarded = req.headers?.['x-forwarded-for'];
    let ip: string;

    if (forwarded) {
      ip = (typeof forwarded === 'string' ? forwarded : forwarded[0])
        .split(',')[0]
        .trim();
    } else {
      ip = req.ip ?? req.connection?.remoteAddress ?? '127.0.0.1';
    }

    if (ip.startsWith('::ffff:')) {
      ip = ip.slice(7);
    }

    return ip;
  }

  // ──────────────────────────────────────────────
  // Persistance - Sessions
  // ──────────────────────────────────────────────
  async persistSession(dto: CreateSessionDto, req: any): Promise<void> {
    const ip = this.extractIp(req);
    const ipHash = this.hashIp(ip);
    const geo = await this.geo.resolve(ip);
    const userAgent = String(req?.headers?.['user-agent'] ?? '');

    await this.sessionModel.create({
      sessionId: dto.sessionId,
      visitorId: dto.visitorId,
      userId: dto.userId ?? undefined,
      ipHash,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      geoSource: geo.source,
      device: dto.device,
      browser: dto.browser,
      os: dto.os,
      entryPage: dto.entryPage,
      trafficSource: dto.trafficSource,
      isNewVisitor: dto.isNewVisitor,
      isBot: dto.isBot === true || BOT_PATTERN.test(userAgent),
      isStaff: dto.isStaff === true,
      startedAt: new Date(dto.startedAt),
    });
  }

  // ──────────────────────────────────────────────
  // Persistance - Pageviews
  // ──────────────────────────────────────────────
  async persistPageview(dto: CreateEventDto): Promise<void> {
    await this.eventModel.create({
      sessionId: dto.sessionId,
      visitorId: dto.visitorId,
      userId: dto.userId ?? undefined,
      type: 'pageview',
      url: dto.url,
      duration: dto.duration,
      metadata: dto.metadata,
      isBot: dto.isBot === true,
      isStaff: dto.isStaff === true,
      timestamp: new Date(dto.timestamp),
    });
  }

  // ──────────────────────────────────────────────
  // Persistance - Événements métier
  // ──────────────────────────────────────────────
  async persistEvent(dto: CreateEventDto): Promise<void> {
    await this.eventModel.create({
      sessionId: dto.sessionId,
      visitorId: dto.visitorId,
      userId: dto.userId ?? undefined,
      type: dto.type,
      url: dto.url,
      duration: dto.duration,
      metadata: dto.metadata,
      isBot: dto.isBot === true,
      isStaff: dto.isStaff === true,
      timestamp: new Date(dto.timestamp),
    });
  }

  // ──────────────────────────────────────────────
  // Persistance - Fin de session
  // ──────────────────────────────────────────────
  async endSession(sessionId: string, dto: EndSessionDto): Promise<void> {
    await this.sessionModel.findOneAndUpdate(
      { sessionId },
      {
        exitPage: dto.exitPage,
        duration: dto.duration,
        endedAt: new Date(),
      },
    );
  }
}
