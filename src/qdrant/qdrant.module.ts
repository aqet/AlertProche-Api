import { Module } from '@nestjs/common';
import { QdrantService } from './qdrant.service';

/**
 * Base vectorielle Qdrant (signatures visuelles des publications).
 * ConfigModule étant global, `ConfigService` est injectable directement.
 */
@Module({
  providers: [QdrantService],
  exports: [QdrantService],
})
export class QdrantModule {}
