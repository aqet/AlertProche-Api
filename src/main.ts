import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';

// Origines autorisées — frontend déployé + développement local
const ALLOWED_ORIGINS = [
  'https://alert-proche.vercel.app',   // Frontend Vercel (production)
  'http://localhost:4200',              // Développement local Angular
  'http://localhost:3000',              // Développement local NestJS
];

let cachedServer: any;

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

  // CORS — liste blanche explicite
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Requêtes sans origin (Postman, server-to-server, curl)
      if (!origin) return callback(null, true);

      // Vérifier dans la liste blanche
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

      // Autoriser toutes les origines Vercel du projet (previews de déploiement)
      if (origin.endsWith('.vercel.app')) return callback(null, true);

      // Refuser les autres
      return callback(new Error(`CORS: origine non autorisée — ${origin}`));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'x-verify-token'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Fichiers statiques (uniquement en local — Vercel est read-only)
  if (process.env.NODE_ENV !== 'production') {
    const uploadsDir = join(process.cwd(), 'uploads', 'images');
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });
  }
}

// ── Handler Vercel (serverless) ──────────────────────────────────────────────
export default async (req: any, res: any) => {
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
