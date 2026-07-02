import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import * as geoip from 'geoip-lite';

import { TrackingSession, TrackingSessionDocument } from './schemas/tracking-session.schema';
import { TrackingEvent, TrackingEventDocument } from './schemas/tracking-event.schema';
import { CreateSessionDto } from './dto/create-session.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EndSessionDto } from './dto/end-session.dto';

@Injectable()
export class TrackingService {
  constructor(
    @InjectModel(TrackingSession.name)
    private readonly sessionModel: Model<TrackingSessionDocument>,
    @InjectModel(TrackingEvent.name)
    private readonly eventModel: Model<TrackingEventDocument>,
  ) {}

  // ──────────────────────────────────────────────
  // Tâche 4.1 — Hachage IP
  // SHA-256 puis on garde les 16 premiers chars hex :
  // suffisant pour dé-duplication sans révéler l'IP réelle.
  // ──────────────────────────────────────────────
  hashIp(ip: string): string {
    return createHash('sha256').update(ip).digest('hex').slice(0, 16);
  }

  // ──────────────────────────────────────────────
  // Tâche 4.3 — Résolution géographique
  // Les IPs privées / loopback ne sont pas dans la base GeoIP,
  // on les court-circuite directement pour éviter un lookup inutile.
  // ──────────────────────────────────────────────
  resolveGeo(ip: string): { country: string; city: string } {
    const unknown = { country: 'Unknown', city: 'Unknown' };

    // Détection des plages privées et loopback
    if (
      ip === '::1' ||
      ip.startsWith('127.') ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('::ffff:') ||
      this.isPrivate172(ip)
    ) {
      return unknown;
    }

    try {
      const geo = geoip.lookup(ip);
      if (!geo) return unknown;
      return {
        country: geo.country || 'Unknown',
        city: geo.city || 'Unknown',
      };
    } catch {
      return unknown;
    }
  }

  // ──────────────────────────────────────────────
  // Tâche 4.4 — Extraction de l'IP réelle
  // X-Forwarded-For peut contenir "clientIp, proxy1, proxy2" ;
  // on prend le premier élément (l'IP d'origine).
  // Le préfixe ::ffff: indique une IPv4 encapsulée en IPv6.
  // ──────────────────────────────────────────────
  extractIp(req: any): string {
    const forwarded = req.headers?.['x-forwarded-for'];
    let ip: string;

    if (forwarded) {
      // Prendre la première IP de la liste
      ip = (typeof forwarded === 'string' ? forwarded : forwarded[0])
        .split(',')[0]
        .trim();
    } else {
      ip = req.ip ?? req.connection?.remoteAddress ?? '127.0.0.1';
    }

    // Supprimer le préfixe ::ffff: (IPv4 mappé en IPv6)
    if (ip.startsWith('::ffff:')) {
      ip = ip.slice(7);
    }

    return ip;
  }

  // ──────────────────────────────────────────────
  // Persistance — Sessions
  // ──────────────────────────────────────────────
  async persistSession(dto: CreateSessionDto, req: any): Promise<void> {
    const ip = this.extractIp(req);
    const ipHash = this.hashIp(ip);
    const { country, city } = this.resolveGeo(ip);

    await this.sessionModel.create({
      sessionId: dto.sessionId,
      visitorId: dto.visitorId,
      userId: dto.userId ?? undefined,
      ipHash,
      country,
      city,
      device: dto.device,
      browser: dto.browser,
      os: dto.os,
      entryPage: dto.entryPage,
      trafficSource: dto.trafficSource,
      isNewVisitor: dto.isNewVisitor,
      startedAt: new Date(dto.startedAt),
    });
  }

  // ──────────────────────────────────────────────
  // Persistance — Pageviews
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
      timestamp: new Date(dto.timestamp),
    });
  }

  // ──────────────────────────────────────────────
  // Persistance — Événements métier
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
      timestamp: new Date(dto.timestamp),
    });
  }

  // ──────────────────────────────────────────────
  // Persistance — Fin de session
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

  // ──────────────────────────────────────────────
  // Analytics — helpers & endpoints
  // ──────────────────────────────────────────────

  // Convertit "7d" / "30d" / "90d" en Date de début de période
  periodToDate(period: string): Date {
    const days = parseInt(period) || 30;
    return new Date(Date.now() - days * 24 * 3600 * 1000);
  }

  async getOverview(period: string) {
    const since = this.periodToDate(period);
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    const [totalSessions, totalPageviews, registrations, activeSessions, todaySessions] =
      await Promise.all([
        this.sessionModel.countDocuments({ startedAt: { $gte: since } }),
        this.eventModel.countDocuments({ type: 'pageview', timestamp: { $gte: since } }),
        this.eventModel.countDocuments({ type: 'user_registered', timestamp: { $gte: since } }),
        this.sessionModel.countDocuments({ startedAt: { $gte: fiveMinAgo } }),
        this.sessionModel.countDocuments({ startedAt: { $gte: todayStart } }),
      ]);

    const uniqueVisitors = (
      await this.sessionModel.distinct('visitorId', { startedAt: { $gte: since } })
    ).length;
    const newVisitors = await this.sessionModel.countDocuments({
      isNewVisitor: true,
      startedAt: { $gte: since },
    });

    return {
      totalSessions,
      totalPageviews,
      uniqueVisitors,
      newVisitors,
      returningVisitors: uniqueVisitors - newVisitors,
      conversionRate:
        totalSessions > 0 ? Math.round((registrations / totalSessions) * 1000) / 10 : 0,
      activeSessions,
      todaySessions,
    };
  }

  async getTopPages(period: string) {
    const since = this.periodToDate(period);
    return this.eventModel.aggregate([
      { $match: { type: 'pageview', timestamp: { $gte: since } } },
      { $group: { _id: '$url', views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, url: '$_id', views: 1 } },
    ]);
  }

  async getTopPosts(period: string) {
    const since = this.periodToDate(period);
    return this.eventModel.aggregate([
      {
        $match: {
          type: 'pageview',
          url: { $regex: '^/posts/' }, // Pages de détail de posts
          timestamp: { $gte: since },
        },
      },
      { $group: { _id: '$url', views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, url: '$_id', views: 1 } },
    ]);
  }

  async getGeo(period: string) {
    const since = this.periodToDate(period);
    return this.sessionModel.aggregate([
      { $match: { startedAt: { $gte: since } } },
      {
        $group: {
          _id: { country: '$country', city: '$city' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 50 },
      { $project: { _id: 0, country: '$_id.country', city: '$_id.city', count: 1 } },
    ]);
  }

  async getDevices(period: string) {
    const since = this.periodToDate(period);
    const results = await this.sessionModel.aggregate([
      { $match: { startedAt: { $gte: since } } },
      { $group: { _id: '$device', count: { $sum: 1 } } },
      { $project: { _id: 0, device: '$_id', count: 1 } },
    ]);
    const total = results.reduce((s, r) => s + r.count, 0);
    return results.map((r) => ({
      ...r,
      percentage: total > 0 ? Math.round((r.count / total) * 100) : 0,
    }));
  }

  async getSources(period: string) {
    const since = this.periodToDate(period);
    const results = await this.sessionModel.aggregate([
      { $match: { startedAt: { $gte: since } } },
      { $group: { _id: '$trafficSource', count: { $sum: 1 } } },
      { $project: { _id: 0, source: '$_id', count: 1 } },
    ]);
    const total = results.reduce((s, r) => s + r.count, 0);
    return results.map((r) => ({
      ...r,
      percentage: total > 0 ? Math.round((r.count / total) * 100) : 0,
    }));
  }

  async getActivity(period: string) {
    const since = this.periodToDate(period);
    const [sessions, pageviews] = await Promise.all([
      this.sessionModel.aggregate([
        { $match: { startedAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } },
            sessions: { $sum: 1 },
          },
        },
      ]),
      this.eventModel.aggregate([
        { $match: { type: 'pageview', timestamp: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            pageviews: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Fusionner les deux séries par date
    const map = new Map<string, { sessions: number; pageviews: number }>();
    sessions.forEach((s) => map.set(s._id, { sessions: s.sessions, pageviews: 0 }));
    pageviews.forEach((p) => {
      const entry = map.get(p._id) ?? { sessions: 0, pageviews: 0 };
      entry.pageviews = p.pageviews;
      map.set(p._id, entry);
    });

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));
  }

  // ──────────────────────────────────────────────
  // Helpers privés
  // ──────────────────────────────────────────────

  // Détecte la plage 172.16.0.0 – 172.31.255.255
  private isPrivate172(ip: string): boolean {
    const match = ip.match(/^172\.(\d{1,3})\./);
    if (!match) return false;
    const second = parseInt(match[1], 10);
    return second >= 16 && second <= 31;
  }
}
