#!/usr/bin/env node
/**
 * Ré-indexation des visages des avis de disparition dans Qdrant.
 *
 * Usage (depuis alertproche-api/) :
 *   npm run build
 *   node scripts/reindex-faces.js              # détecte + indexe tous les avis
 *   node scripts/reindex-faces.js --dry-run    # détecte seulement, n'écrit rien
 *   node scripts/reindex-faces.js --status     # état Qdrant / MongoDB
 *   node scripts/reindex-faces.js --limit 5    # limite le nombre de publications
 *
 * Le script relit les images depuis `image_url` (Cloudinary) : aucune donnée
 * biométrique n'est stockée en base en dehors des vecteurs Qdrant.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const API_DIR = path.join(__dirname, '..');
const COLLECTION = 'post_faces';
const VECTOR_SIZE = 512;
const BATCH_DELAY_MS = 0;

let faceToPointId;
let FaceEngine;
try {
  ({ faceToPointId } = require(path.join(API_DIR, 'dist', 'qdrant', 'qdrant.util.js')));
  ({ FaceEngine, resolveModelsDir } = require(path.join(API_DIR, 'dist', 'faces', 'face-engine.js')));
} catch {
  console.error('❌ dist/ introuvable - lancez d’abord : npm run build');
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
const DRY_RUN = args.includes('--dry-run');
const STATUS = args.includes('--status');
const LIMIT_INDEX = args.indexOf('--limit');
const LIMIT = LIMIT_INDEX >= 0 ? Number(args[LIMIT_INDEX + 1]) || 0 : 0;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI absent de alertproche-api/.env');
  process.exit(1);
}
const qdrantConfigured =
  !!QDRANT_URL && !/VOTRE-CLUSTER|your-cluster|example\.com/i.test(QDRANT_URL);

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

async function ensureCollection() {
  let exists = true;
  try {
    await qdrantRequest('GET', `/collections/${COLLECTION}`);
  } catch {
    exists = false;
  }

  if (!exists) {
    await qdrantRequest('PUT', `/collections/${COLLECTION}`, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });
    console.log(`▶ Collection « ${COLLECTION} » créée (${VECTOR_SIZE} dims, Cosine).`);
  }

  // Qdrant exige un index de payload pour filtrer/supprimer par postId.
  await qdrantRequest('PUT', `/collections/${COLLECTION}/index?wait=true`, {
    field_name: 'postId',
    field_schema: 'keyword',
  });
}

async function countPoints() {
  const info = await qdrantRequest('GET', `/collections/${COLLECTION}`);
  return info?.result?.points_count ?? 0;
}

async function replaceFaces(post, faces) {
  await qdrantRequest('POST', `/collections/${COLLECTION}/points/delete?wait=true`, {
    filter: { must: [{ key: 'postId', match: { value: post._id.toString() } }] },
  });

  if (faces.length === 0) return;

  await qdrantRequest('PUT', `/collections/${COLLECTION}/points?wait=true`, {
    points: faces.map((face, index) => ({
      id: faceToPointId(post._id.toString(), index),
      vector: face.embedding,
      payload: {
        postId: post._id.toString(),
        faceIndex: index,
        faceScore: face.score,
        bbox: face.bbox,
        ...payloadFor(post),
      },
    })),
  });
}

function payloadFor(post) {
  return {
    title: post.title ?? null,
    location: post.location ?? null,
    type: post.type ?? null,
    image_url: post.image_url ?? null,
    isActive: post.isActive ?? true,
    isResolved: post.isResolved ?? false,
    createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
  };
}

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const posts = mongoose.connection.db.collection('posts');

  const query = {
    type: 'Disparition',
    image_url: { $nin: [null, ''] },
  };
  const total = await posts.countDocuments(query);
  console.log(`\n▶ MongoDB : ${total} avis de disparition avec image.`);

  if (!qdrantConfigured) {
    console.error('❌ QDRANT_URL absent ou non renseigné dans .env');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (STATUS) {
    await ensureCollection();
    const indexed = await countPoints();
    console.log(`▶ Qdrant  : ${indexed} visage(s) dans « ${COLLECTION} ».`);
    await mongoose.disconnect();
    return;
  }

  const modelsDir = resolveModelsDir();
  if (!modelsDir) {
    console.error('❌ Modèles introuvables (dist/faces/models).');
    await mongoose.disconnect();
    process.exit(1);
  }

  const engine = new FaceEngine(modelsDir);
  console.log(`▶ Modèles : ${modelsDir}`);
  await engine.initialize();

  let docs = await posts
    .find(query, {
      projection: {
        title: 1,
        location: 1,
        type: 1,
        image_url: 1,
        isActive: 1,
        isResolved: 1,
        createdAt: 1,
      },
    })
    .sort({ createdAt: -1 })
    .toArray();

  if (LIMIT > 0) docs = docs.slice(0, LIMIT);

  if (!DRY_RUN) await ensureCollection();

  let processed = 0;
  let withFaces = 0;
  let faceCount = 0;
  const failures = [];

  for (const post of docs) {
    processed += 1;
    const started = Date.now();

    try {
      const response = await fetch(post.image_url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());

      const { faces } = await engine.extractFaces(buffer);
      withFaces += faces.length > 0 ? 1 : 0;
      faceCount += faces.length;

      if (!DRY_RUN) await replaceFaces(post, faces);

      console.log(
        `${faces.length ? '👤' : '- '} ${faces.length} visage(s) en ${Date.now() - started} ms - [${post._id}] ${String(post.title).slice(0, 55)}`,
      );
    } catch (err) {
      failures.push({ postId: post._id.toString(), error: err.message });
      console.log(`❌ ${err.message} - ${post.title}`);
    }

    if (BATCH_DELAY_MS) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
  }

  console.log('\n══════════ BILAN ══════════');
  console.log(`Publications traitées : ${processed}`);
  console.log(`Avec ≥ 1 visage        : ${withFaces}`);
  console.log(`Visages détectés       : ${faceCount}`);
  if (!DRY_RUN) console.log(`Points Qdrant          : ${await countPoints()}`);

  if (!DRY_RUN) {
    // Vérification : chaque visage indexé doit se retrouver lui-même.
    console.log('\n▶ Vérification par self-search…');
    let checked = 0;
    let ok = 0;

    for (const post of docs.slice(0, 40)) {
      const response = await fetch(post.image_url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      const { faces } = await engine.extractFaces(buffer);
      if (!faces.length) continue;

      checked += 1;
      const result = await qdrantRequest(
        'POST',
        `/collections/${COLLECTION}/points/query`,
        { query: faces[0].embedding, limit: 5, with_payload: true },
      );
      const points = result?.result?.points ?? [];
      const self = points.find(
        (p) => String(p.payload?.postId) === post._id.toString(),
      );
      if (self && (self.score ?? 0) >= 0.99) ok += 1;
      else
        failures.push({
          postId: post._id.toString(),
          error: `self-search: score ${self?.score ?? 'absent'}`,
        });
    }

    console.log(`  ${ok}/${checked} publication(s) retrouvée(s) par leur propre visage.`);
  }

  const uniqueFailures = [...new Set(failures.map((f) => `${f.postId}: ${f.error}`))];
  if (uniqueFailures.length > 0) {
    console.log(`\n⚠️ ${uniqueFailures.length} anomalie(s) :`);
    for (const failure of uniqueFailures.slice(0, 10)) console.log('  ', failure);
  }

  if (DRY_RUN) console.log('\n(dry-run : aucune écriture dans Qdrant)');

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
