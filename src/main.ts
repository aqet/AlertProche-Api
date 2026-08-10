import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import { initializeApp, getApps, cert } from 'firebase-admin/app';

// ── Firebase Admin - initialisation unique et robuste ─────────────────────
function ensureFirebaseInit() {
  if (getApps().length > 0) return; // Déjà initialisé

  const projectId   = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey  = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.error('❌ Variables Firebase manquantes dans les env vars.');
    return;
  }

  try {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    console.log('✅ Firebase Admin SDK initialisé');
  } catch (err: any) {
    console.error('❌ Erreur Firebase Admin init:', err?.message || err);
  }
}

// Appel immédiat au chargement du module
ensureFirebaseInit();

// Origines autorisées
const ALLOWED_ORIGINS = [
  'https://alert-proche.vercel.app',
  'http://localhost:4200',
  'https://localhost',
];

async function setupApp(app: NestExpressApplication) {

  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  // Validation globale des DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // CORS - liste blanche explicite
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Requêtes sans origin (Postman, server-to-server, curl)
      if (!origin) return callback(null, true);

      // Vérifier dans la liste blanche
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

      // Autoriser toutes les origines Vercel du projet (previews de déploiement)
      if (origin.endsWith('.vercel.app')) return callback(null, true);

      // Refuser les autres
      return callback(new Error(`CORS: origine non autorisée - ${origin}`));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'x-verify-token'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Fichiers statiques (uniquement en local - Vercel est read-only)
  if (process.env.NODE_ENV !== 'production') {
    const uploadsDir = join(process.cwd(), 'uploads', 'images');
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });
  }
}
let cachedServer: any;

// ── Handler Vercel (serverless) ──────────────────────────────────────────────
export default async (req: any, res: any) => {
  ensureFirebaseInit(); // Réinitialise si l'instance froide ne l'a pas fait
  if (!cachedServer) {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    await setupApp(app);
    await app.init();
    cachedServer = app.getHttpAdapter().getInstance();
  }
  return cachedServer(req, res);
};

// ── Démarrage local ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  (async () => {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    await setupApp(app);
    const port = process.env.PORT || 3000;
    await app.listen(port);
  })();
}
