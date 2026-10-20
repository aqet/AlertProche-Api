import { createHash } from 'crypto';

/**
 * Espace de noms UUID fixe (RFC 4122) utilisé pour dériver les identifiants de
 * points Qdrant à partir des `_id` Mongo des publications.
 *
 * ⚠️ Ne jamais modifier : tout changement invaliderait les points déjà indexés.
 * Garder synchronisé avec `scripts/migrate-vectors.js` (qui importe ce module).
 */
const NAMESPACE_BYTES = Buffer.from(
  'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'hex',
);

/**
 * Convertit un identifiant Mongo (24 caractères hexadécimaux) en UUID v5
 * déterministe.
 *
 * Qdrant n'accepte que des UUID ou des entiers 64 bits comme identifiant de
 * point : un ObjectId Mongo n'est ni l'un ni l'autre. On dérive donc un UUID v5
 * (SHA-1 de `namespace + postId`) — déterministe, donc les upserts sont
 * idempotents et les suppressions se font par identifiant direct.
 */
export function postIdToPointId(postId: string): string {
  const hash = createHash('sha1')
    .update(NAMESPACE_BYTES)
    .update(String(postId))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
