import { Module } from '@nestjs/common';
import { FacesService } from './faces.service';

/**
 * Reconnaissance faciale (SCRFD + ArcFace) pour les avis de disparition.
 * Les modèles sont embarqués dans `src/faces/models/`.
 */
@Module({
  providers: [FacesService],
  exports: [FacesService],
})
export class FacesModule {}
