import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { postIdToPointId } from './qdrant.util';

/** Collection Qdrant dédiée aux signatures visuelles des publications. */
export const POSTS_COLLECTION = 'post_images';

/**
 * Dimensions des embeddings d'images Gemini (`gemini-embedding-2`).
 * Vérifié sur les données existantes : 3072.
 */
export const EMBEDDING_SIZE = 3072;

/** Nombre de résultats renvoyés par la recherche par image. */
export const MAX_SEARCH_RESULTS = 5;

/** Métadonnées stockées avec chaque vecteur (évite un aller-retour Mongo). */
export interface PostVectorPayload {
  postId: string;
  title?: string;
  location?: string;
  type?: string;
  image_url?: string | null;
  isActive?: boolean;
  isResolved?: boolean;
  createdAt?: string | Date | null;
}

/** Résultat de recherche, au format attendu par le frontend. */
export interface VectorSearchResult {
  _id: string;
  title?: string;
  location?: string;
  image_url?: string | null;
  score: number;
}

/**
 * Accès à la base vectorielle Qdrant.
 *
 * La collection est créée à la demande (paresseusement, une seule fois par
 * instance) : une panne Qdrant au démarrage ne doit jamais empêcher l'API de
 * servir le reste. Les méthodes lèvent une erreur explicite si Qdrant n'est pas
 * configuré / joignable — c'est à l'appelant de choisir sa politique.
 */
@Injectable()
export class QdrantService {
  private readonly logger = new Logger(QdrantService.name);
  private readonly client: QdrantClient | null;
  private readonly isConfigured: boolean;

  /** Promesse de création de collection mémoïsée (réinitialisée en cas d'échec). */
  private ensurePromise: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {
    const rawUrl = (config.get<string>('QDRANT_URL') || '').trim();
    const apiKey = (config.get<string>('QDRANT_API_KEY') || '').trim();

    // Une valeur de gabarit ("VOTRE-CLUSTER", "your-cluster"…) compte comme non configurée.
    this.isConfigured =
      !!rawUrl && !/VOTRE-CLUSTER|your-cluster|example\.com/i.test(rawUrl);

    if (this.isConfigured) {
      this.client = new QdrantClient({
        url: rawUrl.replace(/\/+$/, ''),
        apiKey: apiKey || undefined,
        // Évite un appel de contrôle de version supplémentaire à chaque démarrage.
        checkCompatibility: false,
      });
      this.logger.log(`Qdrant configuré : ${rawUrl}`);
    } else {
      this.client = null;
      this.logger.warn(
        'Qdrant non configuré (QDRANT_URL / QDRANT_API_KEY absents) — la recherche par image est désactivée.',
      );
    }
  }

  get configured(): boolean {
    return this.isConfigured;
  }

  private requireClient(): QdrantClient {
    if (!this.client) {
      throw new InternalServerErrorException(
        'Recherche par image indisponible : Qdrant non configuré (QDRANT_URL / QDRANT_API_KEY).',
      );
    }
    return this.client;
  }

  /** Crée la collection si nécessaire (idempotent, mémoïsé). */
  private ensureCollection(): Promise<void> {
    if (!this.ensurePromise) {
      this.ensurePromise = this.doEnsureCollection().catch((err) => {
        // On ne mémorise pas un échec : la prochaine requête réessaiera.
        this.ensurePromise = null;
        throw err;
      });
    }
    return this.ensurePromise;
  }

  private async doEnsureCollection(): Promise<void> {
    const client = this.requireClient();
    const { exists } = await client.collectionExists(POSTS_COLLECTION);
    if (exists) return;

    await client.createCollection(POSTS_COLLECTION, {
      vectors: { size: EMBEDDING_SIZE, distance: 'Cosine' },
    });
    this.logger.log(
      `Collection Qdrant « ${POSTS_COLLECTION} » créée (${EMBEDDING_SIZE} dims, Cosine).`,
    );
  }

  /** Indexe (ou remplace) le vecteur d'une publication. Lève en cas d'échec. */
  async upsertPost(post: PostVectorPayload, vector: number[]): Promise<void> {
    await this.ensureCollection();
    const client = this.requireClient();

    await client.upsert(POSTS_COLLECTION, {
      wait: true,
      points: [
        {
          id: postIdToPointId(post.postId),
          vector,
          payload: {
            postId: post.postId,
            title: post.title ?? null,
            location: post.location ?? null,
            type: post.type ?? null,
            image_url: post.image_url ?? null,
            isActive: post.isActive ?? true,
            isResolved: post.isResolved ?? false,
            createdAt:
              post.createdAt instanceof Date
                ? post.createdAt.toISOString()
                : (post.createdAt ?? null),
          },
        },
      ],
    });
  }

  /** Recherche les publications les plus proches d'un vecteur donné. */
  async searchSimilar(
    vector: number[],
    limit: number = MAX_SEARCH_RESULTS,
  ): Promise<VectorSearchResult[]> {
    await this.ensureCollection();
    const client = this.requireClient();

    const response = await client.query(POSTS_COLLECTION, {
      query: vector,
      limit,
      with_payload: true,
      with_vector: false,
    });

    return (response.points ?? [])
      .map((point) => {
        const payload = (point.payload ?? {}) as Record<string, any>;
        return {
          _id: String(payload.postId ?? point.id),
          title: payload.title ?? undefined,
          location: payload.location ?? undefined,
          image_url: payload.image_url ?? null,
          score: typeof point.score === 'number' ? point.score : 0,
        };
      })
      .filter((result) => Boolean(result._id));
  }

  /** Supprime le vecteur d'une publication. Lève en cas d'échec. */
  async deletePost(postId: string): Promise<void> {
    await this.ensureCollection();
    const client = this.requireClient();

    await client.delete(POSTS_COLLECTION, {
      wait: true,
      points: [postIdToPointId(postId)],
    });
  }

  /** Nombre de points indexés (diagnostic / script de migration). */
  async countPoints(): Promise<number> {
    const client = this.requireClient();
    const info = await client.getCollection(POSTS_COLLECTION);
    return info.points_count ?? 0;
  }
}
