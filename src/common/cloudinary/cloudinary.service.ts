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
   * Supprime une image Cloudinary à partir de son URL.
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
      await cloudinary.uploader.destroy(publicId);
    } catch { /* ignore les erreurs de suppression */ }
  }
}
