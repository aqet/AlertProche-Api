// import { NestFactory } from '@nestjs/core';
// import { ValidationPipe } from '@nestjs/common';
// import { NestExpressApplication } from '@nestjs/platform-express';
// import { join } from 'path';
// import { existsSync, mkdirSync } from 'fs';
// import { AppModule } from './app.module';

// async function bootstrap() {
//   const app = await NestFactory.create<NestExpressApplication>(AppModule);

//   // Créer le dossier uploads s'il n'existe pas
//   const uploadsDir = join(process.cwd(), 'uploads', 'images');
//   if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

//   // Servir les fichiers uploadés statiquement via Express
//   app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });

//   // Validation globale des DTOs
//   app.useGlobalPipes(
//     new ValidationPipe({
//       whitelist: true,
//       forbidNonWhitelisted: false,
//       transform: true,
//       transformOptions: { enableImplicitConversion: true },
//     }),
//   );

//   // CORS — autoriser le frontend Angular
//   app.enableCors({
//     origin: process.env.FRONTEND_URL || 'http://localhost:4200',
//     methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
//     allowedHeaders: ['Content-Type', 'Authorization'],
//     credentials: true,
//   });

//   const port = process.env.PORT || 3000;
//   await app.listen(port);
//   console.log(`\n🚀 AlertProche API démarrée sur http://localhost:${port}`);
//   console.log(`📦 MongoDB: ${process.env.MONGODB_URI}`);
//   console.log(`📁 Images servies sur: http://localhost:${port}/uploads/images/`);
// }

// bootstrap();


import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { AppModule } from './app.module';

let cachedServer: any;

// Fonction centralisée pour configurer l'application NestJS
async function setupApp(app: NestExpressApplication) {
  // 1. Validation globale des DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // 2. CORS — autoriser le frontend Angular
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:4200',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // 3. Gestion des fichiers locaux (UNIQUEMENT hors production Vercel)
  // Vercel n'autorise pas l'écriture sur son disque. En production, il faudra utiliser 
  // un service comme Cloudinary ou AWS S3 pour stocker les images d'AlertProche.
  if (process.env.NODE_ENV !== 'production') {
    const uploadsDir = join(process.cwd(), 'uploads', 'images');
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
    app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads' });
  }
}

// --- CONFIGURATION EXCLUSIVE POUR VERCEL (SERVERLESS) ---
export default async (req: any, res: any) => {
  if (!cachedServer) {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    await setupApp(app);
    await app.init();
    cachedServer = app.getHttpAdapter().getInstance();
  }
  return cachedServer(req, res);
};

// --- CONFIGURATION POUR LE DÉVELOPPEMENT LOCAL ---
if (process.env.NODE_ENV !== 'production') {
  async function bootstrapLocal() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    await setupApp(app);
    
    const port = process.env.PORT || 3000;
    await app.listen(port);
    console.log(`\n🚀 AlertProche API démarrée en LOCAL sur http://localhost:${port}`);
    console.log(`📦 MongoDB connectée.`);
    console.log(`📁 Images locales servies sur: http://localhost:${port}/uploads/images/`);
  }
  bootstrapLocal();
}