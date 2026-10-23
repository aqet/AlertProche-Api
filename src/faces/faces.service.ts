import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  FaceEngine,
  FaceExtractionResult,
  resolveModelsDir,
} from './face-engine';

/**
 * Façade Nest du moteur visage.
 *
 * Deux modes :
 *  - `analyzeFaces` laisse remonter les erreurs (la recherche doit pouvoir
 *    distinguer « aucun visage » de « moteur en panne ») ;
 *  - `extractFaces` absorbe les erreurs et renvoie une liste vide (indexation
 *    d'une annonce : une photo illisible ne doit pas faire échouer la
 *    publication).
 */
@Injectable()
export class FacesService implements OnModuleInit {
  private readonly logger = new Logger(FacesService.name);
  private readonly engine: FaceEngine | null;

  constructor() {
    const modelsDir = resolveModelsDir();

    if (modelsDir) {
      this.engine = new FaceEngine(modelsDir);
      this.logger.log(`Moteur visage prêt (modèles : ${modelsDir}).`);
    } else {
      this.engine = null;
      this.logger.warn(
        'Modèles de reconnaissance faciale introuvables - recherche par visage désactivée.',
      );
    }
  }

  /** Indique si le moteur est chargé (modèles présents). */
  get available(): boolean {
    return this.engine !== null;
  }

  /**
   * Charge les modèles et exécute une inférence à vide.
   *
   * Sans ce préchauffage, la première recherche d'un utilisateur paie la
   * compilation WASM et l'initialisation des noyaux (plusieurs secondes).
   * Ici, ce coût est payé au démarrage du serveur.
   */
  async onModuleInit(): Promise<void> {
    if (!this.engine) return;
    const startedAt = Date.now();
    try {
      await this.engine.warmUp();
      this.logger.log(`Moteur visage préchauffé (${Date.now() - startedAt} ms).`);
    } catch (err: any) {
      this.logger.error(
        `Préchauffage du moteur visage impossible : ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Détecte les visages et calcule leurs embeddings.
   * Lève si le moteur est absent ou si l'image ne peut pas être analysée.
   */
  async analyzeFaces(buffer: Buffer): Promise<FaceExtractionResult> {
    if (!this.engine) {
      throw new Error('Moteur de reconnaissance faciale indisponible.');
    }
    return this.engine.extractFaces(buffer);
  }

  /**
   * Variante tolérante : retourne une liste vide en cas d'échec.
   */
  async extractFaces(buffer: Buffer): Promise<FaceExtractionResult> {
    try {
      return await this.analyzeFaces(buffer);
    } catch (err: any) {
      this.logger.error(`Analyse faciale impossible : ${err?.message ?? err}`);
      return { faces: [], image: { width: 0, height: 0 } };
    }
  }
}
