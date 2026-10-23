import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import * as geoip from 'geoip-lite';

import { GeoCache, GeoCacheDocument } from './schemas/geo-cache.schema';

export interface GeoResult {
  country: string;
  countryCode: string;
  city: string;
  source: 'local' | 'api' | 'none';
}

const UNKNOWN: GeoResult = {
  country: 'Non localisé',
  countryCode: '',
  city: 'Non localisé',
  source: 'none',
};

const MEMO_TTL = 24 * 3600 * 1000;
const FAILURE_TTL = 3600 * 1000;
const API_TIMEOUT = 1800;

/**
 * Résolution pays / ville à partir d'une IP.
 *
 * 1. geoip-lite (base locale, aucune donnée ne sort du serveur)
 * 2. ipwho.is en HTTPS uniquement pour les IP non reconnues localement
 *
 * Le résultat est mémorisé en RAM puis en base (collection geo_caches) :
 * une même IP n'est interrogée qu'une seule fois. Les IP privées et locales
 * ne sont jamais envoyées à l'extérieur.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly memo = new Map<string, { value: GeoResult; at: number }>();
  private readonly displayNames: any;

  constructor(
    @InjectModel(GeoCache.name)
    private readonly cacheModel: Model<GeoCacheDocument>,
  ) {
    try {
      // Intl.DisplayNames n'est pas typé dans la lib ES2021 du projet
      this.displayNames = new (Intl as any).DisplayNames(['fr'], { type: 'region' });
    } catch {
      this.displayNames = null;
    }
  }

  /** Convertit un code ISO (CM, FR…) en nom de pays lisible. */
  countryName(code: string): string {
    if (!code) return UNKNOWN.country;
    try {
      return this.displayNames?.of(code) || code;
    } catch {
      return code;
    }
  }

  async resolve(ip: string): Promise<GeoResult> {
    if (!ip || this.isPrivateIp(ip)) return { ...UNKNOWN };

    const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 16);

    const memoized = this.memo.get(ipHash);
    if (memoized) {
      const ttl = memoized.value.source === 'none' ? FAILURE_TTL : MEMO_TTL;
      if (Date.now() - memoized.at < ttl) return memoized.value;
    }

    try {
      const cached = await this.cacheModel.findOne({ ipHash }).lean();
      if (cached) {
        const value: GeoResult = {
          country: cached.country || UNKNOWN.country,
          countryCode: cached.countryCode || '',
          city: cached.city || UNKNOWN.city,
          source: (cached.source as GeoResult['source']) || 'none',
        };
        this.memo.set(ipHash, { value, at: Date.now() });
        return value;
      }
    } catch {
      // Cache indisponible : on continue avec la résolution directe.
    }

    const value = await this.lookup(ip);
    this.memo.set(ipHash, { value, at: Date.now() });

    // On ne mémorise pas les échecs (API en panne) pour pouvoir réessayer.
    if (value.source !== 'none') {
      this.cacheModel
        .updateOne(
          { ipHash },
          { $set: { ...value, ipHash, resolvedAt: new Date() } },
          { upsert: true },
        )
        .catch(() => {});
    }

    return value;
  }

  private async lookup(ip: string): Promise<GeoResult> {
    const local = geoip.lookup(ip);
    if (local?.country) {
      return {
        country: this.countryName(local.country),
        countryCode: local.country,
        city: local.city || UNKNOWN.city,
        source: 'local',
      };
    }

    return (await this.lookupApi(ip)) ?? { ...UNKNOWN };
  }

  private async lookupApi(ip: string): Promise<GeoResult | null> {
    try {
      const res = await fetch(
        `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,city`,
        {
          signal: AbortSignal.timeout(API_TIMEOUT),
          headers: { Accept: 'application/json' },
        },
      );
      if (!res.ok) return null;

      const data: any = await res.json();
      if (!data?.success || !data?.country_code) return null;

      return {
        country: data.country || this.countryName(data.country_code),
        countryCode: data.country_code,
        city: data.city || UNKNOWN.city,
        source: 'api',
      };
    } catch (error: any) {
      // On ne journalise jamais l'IP (donnée personnelle).
      this.logger.warn(`Résolution géo externe indisponible : ${error?.message ?? 'erreur'}`);
      return null;
    }
  }

  private isPrivateIp(ip: string): boolean {
    const v = ip.replace(/^::ffff:/, '');

    if (v === '::1' || v.startsWith('127.') || v === 'localhost') return true;
    if (v.startsWith('10.') || v.startsWith('192.168.')) return true;
    if (v.startsWith('169.254.')) return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;

    const match = /^172\.(\d{1,3})\./.exec(v);
    if (match) {
      const second = parseInt(match[1], 10);
      if (second >= 16 && second <= 31) return true;
    }

    return false;
  }
}
