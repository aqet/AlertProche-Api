import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { TrackingSession } from './schemas/tracking-session.schema';
import { TrackingEvent } from './schemas/tracking-event.schema';
import { GeoService } from './geo.service';

const TZ = 'Africa/Douala';
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const MAX_DURATION = 2 * HOUR;
const MAX_SERIES_POINTS = 400;

type Granularity = 'day' | 'month';

interface PeriodWindow {
  since: Date;
  prevSince: Date | null;
  prevUntil: Date | null;
}

export interface SeriesPoint {
  date: string;
  visitors: number;
  sessions: number;
  pageviews: number;
}

const PERIOD_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '12m': 365,
};

@Injectable()
export class AnalyticsService {
  private readonly dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  private readonly monthFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  });

  constructor(
    @InjectModel(TrackingSession.name) private readonly sessions: Model<any>,
    @InjectModel(TrackingEvent.name) private readonly events: Model<any>,
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('User') private readonly users: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
    @InjectModel('Conversation') private readonly conversations: Model<any>,
    @InjectModel('Message') private readonly messages: Model<any>,
    private readonly geo: GeoService,
  ) {}

  // ════════════════════════════════════════════════════════════════
  // AUDIENCE - qui visite le site
  // ════════════════════════════════════════════════════════════════

  async getAudience(period: string) {
    const { since, prevSince, prevUntil } = this.parsePeriod(period);
    const now = new Date();

    const human = { isBot: { $ne: true } };
    const range = { ...human, startedAt: { $gte: since, $lte: now } };
    const pvRange = { ...human, type: 'pageview', timestamp: { $gte: since, $lte: now } };
    const prevRange = prevSince
      ? { ...human, startedAt: { $gte: prevSince, $lt: prevUntil } }
      : null;
    const prevPvRange = prevSince
      ? { ...human, type: 'pageview', timestamp: { $gte: prevSince, $lt: prevUntil } }
      : null;

    const startKey = await this.seriesStartKey(period, since, now);
    const endKey = this.granularity(period) === 'month' ? this.monthKey(now) : this.dayKey(now);
    const seriesStart = new Date(
      startKey + (this.granularity(period) === 'month' ? '-01' : '') + 'T00:00:00Z',
    );

    const [
      sessions,
      visitors,
      pageviews,
      newVisitors,
      staffSessions,
      botsExcluded,
      durationAgg,
      prevSessions,
      prevVisitors,
      prevPageviews,
      prevDurationAgg,
      seriesPoints,
      pages,
      devices,
      browsers,
      sources,
      geoBreakdown,
      cities,
    ] = await Promise.all([
      this.sessions.countDocuments(range),
      this.sessions.distinct('visitorId', range),
      this.events.countDocuments(pvRange),
      this.sessions.countDocuments({ ...range, isNewVisitor: true }),
      this.sessions.countDocuments({ ...range, isStaff: true }),
      this.sessions.countDocuments({ isBot: true, startedAt: { $gte: since, $lte: now } }),
      this.avgDuration(range),
      prevRange ? this.sessions.countDocuments(prevRange) : Promise.resolve(null),
      prevRange ? this.sessions.distinct('visitorId', prevRange) : Promise.resolve(null),
      prevPvRange ? this.events.countDocuments(prevPvRange) : Promise.resolve(null),
      prevRange ? this.avgDuration(prevRange) : Promise.resolve(null),
      this.buildSeries(range, pvRange, seriesStart, startKey, endKey, this.granularity(period)),
      this.events.aggregate([
        { $match: pvRange },
        { $group: { _id: '$url', views: { $sum: 1 } } },
        { $sort: { views: -1 } },
        { $limit: 12 },
        { $project: { _id: 0, url: '$_id', views: 1 } },
      ]),
      this.breakdown(range, 'device'),
      this.breakdown(range, 'browser', 5),
      this.breakdown(range, 'trafficSource'),
      this.countriesBreakdown(range),
      this.citiesBreakdown(range),
    ]);

    const uniqueVisitors = visitors.length;
    const newCount = newVisitors;
    const returning = Math.max(0, uniqueVisitors - newCount);

    return {
      period,
      since: since.toISOString(),
      until: now.toISOString(),
      granularity: this.granularity(period),
      kpis: {
        visitors: uniqueVisitors,
        sessions,
        pageviews,
        avgDurationMs: Math.round(durationAgg ?? 0),
        pagesPerSession: sessions > 0 ? Math.round((pageviews / sessions) * 10) / 10 : 0,
        newVisitors: newCount,
        returningVisitors: returning,
        staffSessions,
        botsExcluded,
      },
      previous:
        prevSessions === null
          ? null
          : {
              visitors: (prevVisitors as string[]).length,
              sessions: prevSessions,
              pageviews: prevPageviews ?? 0,
              avgDurationMs: Math.round(prevDurationAgg ?? 0),
            },
      series: seriesPoints,
      pages,
      devices,
      browsers,
      sources,
      countries: geoBreakdown.countries,
      localization: geoBreakdown.localization,
      cities,
    };
  }

  // ════════════════════════════════════════════════════════════════
  // ALERTES - ce que la plateforme produit
  // ════════════════════════════════════════════════════════════════

  async getMission(period: string) {
    const { since, prevSince, prevUntil } = this.parsePeriod(period);
    const now = new Date();
    const human = { isBot: { $ne: true } };
    const range = { createdAt: { $gte: since, $lte: now } };
    const prevRange = prevSince
      ? { createdAt: { $gte: prevSince, $lt: prevUntil } }
      : null;

    const [
      activeAlerts,
      disappearances,
      resolvedTotal,
      activeNow,
      imageSearches24h,
      published,
      prevPublished,
      views,
      prevViews,
      commentsCount,
      prevCommentsCount,
      conversations,
      prevConversations,
      resolved,
      prevResolved,
      activePosts,
      resolvedPosts,
      registrations,
      prevRegistrations,
      activeMembers,
      messagesCount,
      imageSearches,
      reports,
      topRows,
      commentsByPost,
    ] = await Promise.all([
      this.posts.countDocuments({ isActive: true }),
      this.posts.countDocuments({ isActive: true, type: 'Disparition' }),
      this.posts.countDocuments({ isResolved: true }),
      this.sessions.countDocuments({
        ...human,
        startedAt: { $gte: new Date(now.getTime() - 5 * 60 * 1000) },
      }),
      this.events.countDocuments({
        type: 'image_search_performed',
        timestamp: { $gte: new Date(now.getTime() - DAY) },
      }),
      this.posts.countDocuments(range),
      prevRange ? this.posts.countDocuments(prevRange) : Promise.resolve(null),
      this.events.countDocuments({
        ...human,
        type: 'pageview',
        url: { $regex: '^/posts/' },
        timestamp: { $gte: since, $lte: now },
      }),
      prevRange
        ? this.events.countDocuments({
            ...human,
            type: 'pageview',
            url: { $regex: '^/posts/' },
            timestamp: { $gte: prevSince, $lt: prevUntil },
          })
        : Promise.resolve(null),
      this.comments.countDocuments(range),
      prevRange ? this.comments.countDocuments(prevRange) : Promise.resolve(null),
      this.conversations.countDocuments(range),
      prevRange ? this.conversations.countDocuments(prevRange) : Promise.resolve(null),
      this.posts.countDocuments({ resolvedAt: { $gte: since, $lte: now } }),
      prevRange
        ? this.posts.countDocuments({ resolvedAt: { $gte: prevSince, $lt: prevUntil } })
        : Promise.resolve(null),
      this.posts
        .find({ isActive: true })
        .select('_id title location type createdAt image_url isResolved')
        .lean(),
      this.posts
        .find({ resolvedAt: { $gte: since, $lte: now } })
        .select('createdAt resolvedAt')
        .lean(),
      this.users.countDocuments(range),
      prevRange ? this.users.countDocuments(prevRange) : Promise.resolve(null),
      this.sessions.distinct('userId', {
        ...human,
        startedAt: { $gte: since, $lte: now },
        userId: { $ne: null },
      }),
      this.messages.countDocuments(range),
      this.events.countDocuments({ ...human, type: 'image_search_performed', timestamp: { $gte: since, $lte: now } }),
      this.posts.countDocuments({ isReported: true }),
      this.events.aggregate([
        {
          $match: {
            ...human,
            type: 'pageview',
            url: { $regex: '^/posts/' },
            timestamp: { $gte: since, $lte: now },
          },
        },
        { $group: { _id: '$url', views: { $sum: 1 } } },
        { $sort: { views: -1 } },
        { $limit: 20 },
      ]),
      this.comments.aggregate([
        { $match: { createdAt: { $gte: since, $lte: now } } },
        { $group: { _id: '$post_id', n: { $sum: 1 } } },
      ]),
    ]);

    // ── Vues par annonce (URL → identifiant Mongo) ───────────────
    const viewsById = new Map<string, number>();
    for (const row of topRows) {
      const id = this.postIdFromUrl(row._id);
      if (!id) continue;
      viewsById.set(id, (viewsById.get(id) ?? 0) + row.views);
    }

    const activeIds = activePosts.map((p: any) => String(p._id));
    const commentedIds = new Set(commentsByPost.map((c: any) => String(c._id)));

    const funnel = {
      active: activeIds.length,
      viewed: activeIds.filter((id) => viewsById.has(id)).length,
      contacted: activeIds.filter((id) => commentedIds.has(id)).length,
      resolved,
    };

    // ── Top annonces ─────────────────────────────────────────────
    const topIds = [...viewsById.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => id);

    let topPosts: any[] = [];
    if (topIds.length) {
      const docs = await this.posts
        .find({ _id: { $in: topIds } })
        .select('_id title location type image_url isResolved createdAt')
        .lean();
      const byId = new Map(docs.map((d: any) => [String(d._id), d]));
      topPosts = topIds
        .map((id) => {
          const doc: any = byId.get(id);
          if (!doc) return null;
          return {
            id,
            title: doc.title,
            location: doc.location,
            type: doc.type,
            imageUrl: doc.image_url || null,
            isResolved: !!doc.isResolved,
            createdAt: doc.createdAt,
            views: viewsById.get(id) ?? 0,
          };
        })
        .filter(Boolean);
    }

    // ── Annonces sans aucune vue sur la période ──────────────────
    const noViews = activePosts
      .filter((p: any) => !viewsById.has(String(p._id)))
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((p: any) => ({
        id: String(p._id),
        title: p.title,
        location: p.location,
        type: p.type,
        createdAt: p.createdAt,
      }));

    // ── Villes déclarées dans les annonces actives ───────────────
    const cityMap = new Map<string, { city: string; count: number }>();
    for (const post of activePosts) {
      const raw = String(post.location || '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase().replace(/\s+/g, ' ');
      const existing = cityMap.get(key);
      if (existing) existing.count += 1;
      else cityMap.set(key, { city: this.capitalize(raw), count: 1 });
    }
    const cities = [...cityMap.values()].sort((a, b) => b.count - a.count).slice(0, 8);

    // ── Délai médian de résolution ───────────────────────────────
    const resolutionHours = resolvedPosts
      .map((p: any) => (new Date(p.resolvedAt).getTime() - new Date(p.createdAt).getTime()) / HOUR)
      .filter((h: number) => Number.isFinite(h) && h >= 0)
      .sort((a: number, b: number) => a - b);
    const medianResolutionHours = resolutionHours.length
      ? Math.round(resolutionHours[Math.floor(resolutionHours.length / 2)] * 10) / 10
      : null;

    return {
      period,
      since: since.toISOString(),
      until: now.toISOString(),
      live: {
        activeAlerts,
        disappearances,
        resolvedTotal,
        activeNow,
        imageSearches24h,
      },
      kpis: {
        published,
        views,
        contacts: commentsCount + conversations,
        comments: commentsCount,
        conversations,
        resolved,
        medianResolutionHours,
      },
      previous:
        prevPublished === null
          ? null
          : {
              published: prevPublished,
              views: prevViews ?? 0,
              contacts: (prevCommentsCount ?? 0) + (prevConversations ?? 0),
              resolved: prevResolved ?? 0,
            },
      funnel,
      series: await this.missionSeries(now),
      topPosts,
      noViews,
      cities,
      community: {
        registrations,
        previousRegistrations: prevRegistrations,
        activeMembers: activeMembers.filter(Boolean).length,
        messages: messagesCount,
        comments: commentsCount,
        imageSearches,
        reports,
      },
    };
  }

  // ════════════════════════════════════════════════════════════════
  // Helpers
  // ════════════════════════════════════════════════════════════════

  private parsePeriod(period: string): PeriodWindow {
    if (period === 'all') {
      return { since: new Date(0), prevSince: null, prevUntil: null };
    }
    const days = PERIOD_DAYS[period] ?? 30;
    const now = Date.now();
    const since = new Date(now - days * DAY);
    return {
      since,
      prevSince: new Date(since.getTime() - days * DAY),
      prevUntil: since,
    };
  }

  private granularity(period: string): Granularity {
    return period === '12m' || period === 'all' ? 'month' : 'day';
  }

  private async seriesStartKey(period: string, since: Date, now: Date): Promise<string> {
    if (this.granularity(period) === 'day') return this.dayKey(since);

    if (period === '12m') return this.addMonths(this.monthKey(now), -11);

    // « Tout » : on démarre au premier mois ayant une session.
    const first: any = await this.sessions
      .findOne({ isBot: { $ne: true } })
      .sort({ startedAt: 1 })
      .select('startedAt')
      .lean();

    return first?.startedAt ? this.monthKey(new Date(first.startedAt)) : this.monthKey(now);
  }

  private async buildSeries(
    range: any,
    pvRange: any,
    seriesStart: Date,
    startKey: string,
    endKey: string,
    granularity: Granularity,
  ): Promise<SeriesPoint[]> {
    const keyExpr = (field: string) =>
      granularity === 'day'
        ? { $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } }
        : { $dateToString: { format: '%Y-%m', date: field, timezone: TZ } };

    const seriesRange = { ...range, startedAt: { $gte: seriesStart } };
    const seriesPvRange = { ...pvRange, timestamp: { $gte: seriesStart } };

    const [sessionRows, pageviewRows] = await Promise.all([
      this.sessions.aggregate([
        { $match: seriesRange },
        {
          $group: {
            _id: keyExpr('$startedAt'),
            sessions: { $sum: 1 },
            visitors: { $addToSet: '$visitorId' },
          },
        },
        { $project: { sessions: 1, visitors: { $size: '$visitors' } } },
      ]),
      this.events.aggregate([
        { $match: seriesPvRange },
        { $group: { _id: keyExpr('$timestamp'), pageviews: { $sum: 1 } } },
      ]),
    ]);

    const sMap = new Map<string, any>(sessionRows.map((r: any) => [r._id, r]));
    const pvMap = new Map<string, number>(pageviewRows.map((r: any) => [r._id, r.pageviews]));

    const keys =
      granularity === 'day'
        ? this.dayKeys(startKey, endKey)
        : this.monthKeys(startKey, endKey);

    return keys.map((key) => ({
      date: key,
      visitors: sMap.get(key)?.visitors ?? 0,
      sessions: sMap.get(key)?.sessions ?? 0,
      pageviews: pvMap.get(key) ?? 0,
    }));
  }

  private async avgDuration(range: any): Promise<number | null> {
    const rows = await this.sessions.aggregate([
      { $match: { ...range, duration: { $gt: 0, $lte: MAX_DURATION } } },
      { $group: { _id: null, avg: { $avg: '$duration' } } },
    ]);
    return rows[0]?.avg ?? null;
  }

  private async breakdown(range: any, field: string, limit?: number) {
    const pipeline: any[] = [
      { $match: range },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ];
    if (limit) pipeline.push({ $limit: limit });

    const rows = await this.sessions.aggregate(pipeline);
    const total = rows.reduce((sum, r) => sum + r.count, 0);

    return rows.map((r) => ({
      label: r._id || 'Non renseigné',
      count: r.count,
      percentage: total > 0 ? Math.round((r.count / total) * 100) : 0,
    }));
  }

  private async countriesBreakdown(range: any) {
    const rows = await this.sessions.aggregate([
      { $match: range },
      {
        $group: {
          _id: { country: '$country', code: '$countryCode' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 30 },
    ]);

    const merged = new Map<string, { code: string; country: string; count: number }>();

    for (const row of rows) {
      const normalized = this.normalizeCountry(row._id?.country, row._id?.code);
      const key = normalized.code || normalized.country;
      const existing = merged.get(key);
      if (existing) existing.count += row.count;
      else merged.set(key, { ...normalized, count: row.count });
    }

    const totalSessions = rows.reduce((sum: number, r: any) => sum + r.count, 0);

    const countries = [...merged.values()]
      .sort((a, b) => b.count - a.count)
      .map((c) => ({
        ...c,
        percentage: totalSessions > 0 ? Math.round((c.count / totalSessions) * 100) : 0,
      }));

    const localized = countries
      .filter((c) => c.country !== 'Non localisé')
      .reduce((sum, c) => sum + c.count, 0);

    return {
      countries,
      localization: {
        localized,
        total: totalSessions,
        rate: totalSessions > 0 ? Math.round((localized / totalSessions) * 100) : 0,
      },
    };
  }

  private async citiesBreakdown(range: any) {
    const rows = await this.sessions.aggregate([
      {
        $match: {
          ...range,
          city: { $nin: [null, '', 'Unknown', 'Non localisé'] },
        },
      },
      {
        $group: {
          _id: { city: '$city', country: '$country', code: '$countryCode' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    return rows.map((row: any) => {
      const normalized = this.normalizeCountry(row._id?.country, row._id?.code);
      return {
        city: row._id?.city || 'Non localisé',
        country: normalized.country,
        count: row.count,
      };
    });
  }

  private async missionSeries(now: Date) {
    const endKey = this.monthKey(now);
    const startKey = this.addMonths(endKey, -11);
    const start = new Date(`${startKey}-01T00:00:00Z`);

    const monthExpr = (field: string) => ({
      $dateToString: { format: '%Y-%m', date: field, timezone: TZ },
    });

    const [publishedRows, resolvedRows] = await Promise.all([
      this.posts.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: monthExpr('$createdAt'), n: { $sum: 1 } } },
      ]),
      this.posts.aggregate([
        { $match: { resolvedAt: { $gte: start } } },
        { $group: { _id: monthExpr('$resolvedAt'), n: { $sum: 1 } } },
      ]),
    ]);

    const publishedMap = new Map<string, number>(
      publishedRows.map((r: any) => [r._id, r.n]),
    );
    const resolvedMap = new Map<string, number>(
      resolvedRows.map((r: any) => [r._id, r.n]),
    );

    return this.monthKeys(startKey, endKey).map((key) => ({
      date: key,
      published: publishedMap.get(key) ?? 0,
      resolved: resolvedMap.get(key) ?? 0,
    }));
  }

  // ── Dates ──────────────────────────────────────────────────────

  private dayKey(date: Date): string {
    const parts = this.dayFmt.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private monthKey(date: Date): string {
    const parts = this.monthFmt.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}`;
  }

  private addMonths(key: string, delta: number): string {
    const [year, month] = key.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1 + delta, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private dayKeys(startKey: string, endKey: string): string[] {
    const keys: string[] = [];
    let cursor = new Date(`${startKey}T00:00:00Z`).getTime();
    const end = new Date(`${endKey}T00:00:00Z`).getTime();

    while (cursor <= end && keys.length < MAX_SERIES_POINTS) {
      keys.push(new Date(cursor).toISOString().slice(0, 10));
      cursor += DAY;
    }
    return keys;
  }

  private monthKeys(startKey: string, endKey: string): string[] {
    const keys: string[] = [];
    let key = startKey;

    while (key <= endKey && keys.length < MAX_SERIES_POINTS) {
      keys.push(key);
      key = this.addMonths(key, 1);
    }
    return keys;
  }

  // ── Divers ─────────────────────────────────────────────────────

  private normalizeCountry(country: string, code?: string) {
    const raw = String(country || '').trim();

    if (code) return { code, country: this.geo.countryName(code) };

    if (/^[A-Z]{2}$/.test(raw)) {
      return { code: raw, country: this.geo.countryName(raw) };
    }

    if (!raw || /^(unknown|non localisé|n\/a|local)$/i.test(raw)) {
      return { code: '', country: 'Non localisé' };
    }

    return { code: '', country: raw };
  }

  private postIdFromUrl(url: string): string | null {
    const match = /^\/posts\/([a-f0-9]{24})/i.exec(String(url || ''));
    return match ? match[1] : null;
  }

  private capitalize(value: string): string {
    return value
      .split(' ')
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
