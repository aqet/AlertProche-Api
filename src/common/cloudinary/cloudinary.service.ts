import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import * as streamifier from 'streamifier';

@Injectable()
export class CloudinaryService {
  private readonly folder: string;
  private readonly isConfigured: boolean;

  constructor(private config: ConfigService) {
    const cloudName  = config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey     = config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret  = config.get<string>('CLOUDINARY_API_SECRET');
    this.folder      = config.get<string>('CLOUDINARY_FOLDER') || 'alertproche/posts';

    // Vérifier que les clés sont présentes
    this.isConfigured = !!(cloudName && apiKey && apiSecret &&
      cloudName !== 'your_cloud_name');

    if (this.isConfigured) {
      cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
    }
  }

  /**
   * Upload une photo de profil (avatar) vers Cloudinary.
   * Optimisé : carré 300x300, WebP, qualité auto → dossier avatars.
   * Remplace l'ancienne photo si elle existait.
   */
  async uploadAvatar(buffer: Buffer, filename: string, userId: string): Promise<string> {
    if (!this.isConfigured) {
      throw new InternalServerErrorException('Cloudinary non configuré.');
    }

    const publicId = `alertproche/avatars/${userId}`;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id:     publicId,
          overwrite:     true,          // remplace l'avatar précédent
          resource_type: 'image',
          folder:        'alertproche/avatars',
          format:        'webp',
          transformation: [
            { width: 300, height: 300, crop: 'fill', gravity: 'face' },
            { quality: 'auto' },
          ],
          allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error) return reject(new InternalServerErrorException(`Avatar upload error: ${error.message}`));
          if (!result) return reject(new InternalServerErrorException('Cloudinary: pas de résultat'));
          resolve(result.secure_url);
        },
      );
      streamifier.createReadStream(buffer).pipe(uploadStream);
    });
  }

  /**
   * Upload un média du feed (image ou vidéo) avec optimisation dédiée.
   * Retourne l'URL sécurisée ET les métadonnées Cloudinary pour suppression fiable.
   */
  async uploadFeedMedia(
    buffer: Buffer,
    filename: string,
    mediaType: 'image' | 'video',
  ): Promise<{ url: string; publicId: string; resourceType: 'image' | 'video' }> {
    if (!this.isConfigured) {
      throw new InternalServerErrorException(
        'Cloudinary non configuré. Vérifiez les variables d\'environnement.',
      );
    }

    const isVideo  = mediaType === 'video';
    const folder   = isVideo ? 'alertproche/feed_videos' : 'alertproche/feed_images';
    const publicId = `${folder}/${Date.now()}-${filename.replace(/\.[^.]+$/, '')}`;

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id:     publicId,
          folder,
          resource_type: isVideo ? 'video' : 'image',
          ...(isVideo
            ? {
                transformation: [
                  { width: 720, crop: 'limit' },
                  { quality: 'auto' },
                ],
              }
            : {
                format: 'webp',
                transformation: [
                  { width: 1080, crop: 'limit' },
                  { quality: 'auto' },
                ],
                allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
              }),
          eager_async: false,
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error) return reject(new InternalServerErrorException(`Cloudinary feed upload error: ${error.message}`));
          if (!result) return reject(new InternalServerErrorException('Cloudinary: pas de résultat'));
          resolve({
            url:          result.secure_url,
            publicId:     result.public_id,
            resourceType: isVideo ? 'video' : 'image',
          });
        },
      );
      streamifier.createReadStream(buffer).pipe(uploadStream);
    });
  }

  /**
   * Supprime un asset Cloudinary avec public_id et resource_type exacts.
   * Plus fiable que deleteByUrl car n'a pas besoin de détecter le type.
   */
  async deleteAsset(publicId: string, resourceType: 'image' | 'video'): Promise<void> {
    if (!this.isConfigured) return;
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch { /* ignore */ }
  }

  /**
   * Upload un fichier Buffer vers Cloudinary.
   * Retourne l'URL sécurisée de l'image.
   */
  async uploadBuffer(buffer: Buffer, filename: string): Promise<string> {
    if (!this.isConfigured) {
      throw new InternalServerErrorException(
        'Cloudinary non configuré. Ajoutez CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY et CLOUDINARY_API_SECRET dans les variables d\'environnement Vercel.',
      );
    }

    return new Promise((resolve, reject) => {
      const publicId = `${this.folder}/${Date.now()}-${filename.replace(/\.[^.]+$/, '')}`;

      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          folder: this.folder,
          resource_type: 'image',
          // Optimisation automatique
          transformation: [
            { quality: 'auto', fetch_format: 'auto' },
            { width: 1200, crop: 'limit' }, // max 1200px de large
          ],
          // Sécurité : pas d'exécution de scripts
          allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error) return reject(new InternalServerErrorException(`Cloudinary upload error: ${error.message}`));
          if (!result) return reject(new InternalServerErrorException('Cloudinary: pas de résultat'));
          resolve(result.secure_url);
        },
      );

      streamifier.createReadStream(buffer).pipe(uploadStream);
    });
  }

  /**
   * Supprime un média Cloudinary à partir de son URL.
   * Détecte automatiquement si c'est une vidéo (resource_type: 'video')
   * ou une image (resource_type: 'image').
   */
  async deleteByUrl(url: string): Promise<void> {
    if (!this.isConfigured || !url?.includes('cloudinary.com')) return;
    try {
      // Extraire le public_id depuis l'URL
      const parts = url.split('/');
      const uploadIndex = parts.indexOf('upload');
      if (uploadIndex === -1) return;
      // Ignorer la version (v1234567) si présente
      const afterUpload = parts.slice(uploadIndex + 1);
      const startIndex = afterUpload[0]?.startsWith('v') ? 1 : 0;
      const publicIdWithExt = afterUpload.slice(startIndex).join('/');
      const publicId = publicIdWithExt.replace(/\.[^.]+$/, '');

      // Détecter le resource_type depuis le dossier ou l'extension
      const isVideo =
        publicId.includes('feed_videos') ||
        publicId.includes('/video/') ||
        /\.(mp4|webm|mov|avi|mkv)$/i.test(url);

      await cloudinary.uploader.destroy(publicId, {
        resource_type: isVideo ? 'video' : 'image',
      });
    } catch { /* ignore les erreurs de suppression */ }
  }
}
