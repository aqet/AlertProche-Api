#!/usr/bin/env node
/**
 * Migration des signatures visuelles : MongoDB (`posts.imageEmbedding`) → Qdrant.
 *
 * Usage (depuis alertproche-api/) :
 *   npm run build                              # compile dist/qdrant/qdrant.util.js
 *   node scripts/migrate-vectors.js            # phase 1 : copie + vérification (Mongo INTACT)
 *   node scripts/migrate-vectors.js --status   # état des deux bases
 *   node scripts/migrate-vectors.js --clean    # phase 2 : $unset imageEmbedding dans Mongo
 *
 * La phase 1 ne modifie jamais MongoDB : elle permet de tester la recherche par
 * image avant de libérer Mongo. La phase 2 refuse de s'exécuter si Qdrant n'a pas
 * au moins autant de points que Mongo n'en a d'embeddings.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const API_DIR = path.join(__dirname, '..');
const COLLECTION = 'post_images';
const BATCH_SIZE = 64;

// ── Identifiant de point : MÊME fonction que l'API (src/qdrant/qdrant.util.ts) ──
let postIdToPointId;
try {
  ({ postIdToPointId } = require(path.join(API_DIR, 'dist', 'qdrant', 'qdrant.util.js')));
} catch {
  console.error(
    '❌ dist/qdrant/qdrant.util.js introuvable — lancez d\'abord : npm run build',
  );
  process.exit(1);
}

// ── .env ──────────────────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  const envPath = path.join(API_DIR, '.env');
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

const env = loadEnv();
const MONGODB_URI = env.MONGODB_URI;
const QDRANT_URL = (env.QDRANT_URL || '').replace(/\/+$/, '');
const QDRANT_API_KEY = env.QDRANT_API_KEY || '';

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const STATUS = args.includes('--status');

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI absent de alertproche-api/.env');
  process.exit(1);
}
const qdrantConfigured = !!QDRANT_URL && !/VOTRE-CLUSTER|your-cluster|example\.com/i.test(QDRANT_URL);

// ── Client Qdrant minimal (REST) ──────────────────────────────────────────────
async function qdrantRequest(method, pathname, body) {
  const response = await fetch(`${QDRANT_URL}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non JSON */
  }
  if (!response.ok) {
    throw new Error(
      `Qdrant ${method} ${pathname} → HTTP ${response.status} ${text.slice(0, 300)}`,
    );
  }
  return json;
}

async function ensureCollection(size) {
  try {
    await qdrantRequest('GET', `/collections/${COLLECTION}`);
    console.log(`  Collection « ${COLLECTION} » déjà présente.`);
  } catch {
    await qdrantRequest('PUT', `/collections/${COLLECTION}`, {
      vectors: { size, distance: 'Cosine' },
    });
    console.log(`  Collection « ${COLLECTION} » créée (${size} dims, Cosine).`);
  }
}

async function qdrantPointCount() {
  const info = await qdrantRequest('GET', `/collections/${COLLECTION}`);
  return info?.result?.points_count ?? 0;
}

// ── Programme ─────────────────────────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const posts = mongoose.connection.db.collection('posts');

  const withEmbedding = await posts.countDocuments({
    imageEmbedding: { $exists: true, $ne: null, $not: { $size: 0 } },
  });
  const total = await posts.countDocuments({});
  console.log(`\n▶ MongoDB : ${total} publication(s), ${withEmbedding} avec embedding.`);

  if (!qdrantConfigured) {
    console.log(
      '⚠️  QDRANT_URL absent ou non renseigné dans .env — opérations Qdrant impossibles.',
    );
    if (STATUS || CLEAN) await mongoose.disconnect();
    if (CLEAN) {
      console.error('❌ Nettoyage refusé : configurez Qdrant d\'abord.');
      process.exit(1);
    }
    return;
  }

  if (STATUS) {
    const points = await qdrantPointCount();
    console.log(`▶ Qdrant  : ${points} point(s) dans « ${COLLECTION} ».`);
    await mongoose.disconnect();
    return;
  }

  // Récupération des vecteurs
  const docs = await posts
    .find(
      { imageEmbedding: { $exists: true, $ne: null, $not: { $size: 0 } } },
      {
        projection: {
          imageEmbedding: 1,
          title: 1,
          location: 1,
          type: 1,
          image_url: 1,
          isActive: 1,
          isResolved: 1,
          createdAt: 1,
        },
      },
    )
    .toArray();

  if (docs.length === 0) {
    console.log('▶ Rien à migrer.');
    await mongoose.disconnect();
    return;
  }

  // Cohérence des dimensions
  const size = docs[0].imageEmbedding.length;
  const inconsistent = docs.filter((d) => d.imageEmbedding.length !== size);
  if (inconsistent.length > 0) {
    console.error(
      `❌ Dimensions incohérentes : ${size} vs ${inconsistent[0].imageEmbedding.length} (${inconsistent.length} doc(s)). Migration annulée.`,
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`▶ Vecteurs : ${docs.length} × ${size} dimensions.`);

  if (CLEAN) {
    // Garde-fou : Qdrant doit contenir au moins autant de points que Mongo d'embeddings.
    const points = await qdrantPointCount();
    if (points < docs.length) {
      console.error(
        `❌ Nettoyage refusé : Qdrant ne contient que ${points} point(s) pour ${docs.length} embedding(s).`,
      );
      await mongoose.disconnect();
      process.exit(1);
    }
    const { modifiedCount } = await posts.updateMany(
      { imageEmbedding: { $exists: true } },
      { $unset: { imageEmbedding: '' } },
    );
    console.log(`✅ \`imageEmbedding\` retiré de ${modifiedCount} publication(s).`);
    console.log('   → Il reste à supprimer l\'index Atlas « vector_index_alertProche » (interface Atlas).');
    await mongoose.disconnect();
    return;
  }

  // ── Phase 1 : copie + vérification ──
  await ensureCollection(size);

  let migrated = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    await qdrantRequest('PUT', `/collections/${COLLECTION}/points?wait=true`, {
      points: batch.map((doc) => ({
        id: postIdToPointId(doc._id.toString()),
        vector: doc.imageEmbedding,
        payload: {
          postId: doc._id.toString(),
          title: doc.title ?? null,
          location: doc.location ?? null,
          type: doc.type ?? null,
          image_url: doc.image_url ?? null,
          isActive: doc.isActive ?? true,
          isResolved: doc.isResolved ?? false,
          createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
        },
      })),
    });
    migrated += batch.length;
    console.log(`  ↑ ${migrated}/${docs.length} vecteurs envoyés`);
  }

  // Vérification 1 : comptage
  const points = await qdrantPointCount();
  console.log(`▶ Qdrant : ${points} point(s) après migration.`);

  // Vérification 2 : chaque vecteur doit se retrouver lui-même en top-1
  console.log('▶ Vérification par self-search…');
  let ok = 0;
  const failures = [];
  for (const doc of docs) {
    const expectedId = postIdToPointId(doc._id.toString());
    const result = await qdrantRequest('POST', `/collections/${COLLECTION}/points/query`, {
      query: doc.imageEmbedding,
      limit: 1,
      with_payload: true,
    });
    const best = result?.result?.points?.[0];
    if (best && String(best.id) === expectedId) {
      ok += 1;
    } else {
      failures.push({ postId: doc._id.toString(), got: best?.id ?? null, expected: expectedId });
    }
  }

  console.log(`\n═════ MIGRATION : ${migrated} envoyés, ${points} points Qdrant, ${ok}/${docs.length} self-search OK ═════`);
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} échec(s) :`);
    for (const failure of failures.slice(0, 5)) console.error('  ', failure);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('✅ Phase 1 terminée — MongoDB est INTACT.');
  console.log('   Testez la recherche par image, puis lancez :');
  console.log('     node scripts/migrate-vectors.js --clean');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('❌ Échec :', error?.message ?? error);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
