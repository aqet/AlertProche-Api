import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as handlebars from 'handlebars';
import * as fs from 'fs';
import { join } from 'path';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;
  private readonly templateDir: string;

  constructor(private readonly config: ConfigService) {
    this.templateDir = join(process.cwd(), 'src', 'mail', 'templates');
    this.initTransporter();
  }

  private initTransporter(): void {
    const user =
      this.config.get<string>('SMTP_USER') || 'tientcheuigorcarel@gmail.com';
    const pass = this.config.get<string>('SMTP_PASS') || 'hqez izyx jkjg iroq';

    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
    });

    this.transporter.verify((err) => {
      if (err) this.logger.warn(`SMTP non vérifié: ${err.message}`);
      else this.logger.log('✅ SMTP connecté — Gmail prêt');
    });
  }

  /**
   * Envoie le code OTP par email pour la vérification d'inscription.
   */
  async sendOtpEmail(
    to: string,
    pseudo: string,
    code: string,
  ): Promise<boolean> {
    const html = this.renderTemplate('otp-verification', {
      pseudo,
      email: to,
      code,
    });

    return this.send({
      to,
      subject: `${code} — Votre code de vérification AlertProche`,
      html,
    });
  }

  async sendLocationUpdateMail(to: string, pseudo: string): Promise<boolean> {
    // 1. Récupération de l'URL de base depuis ton .env (ex: FRONTEND_URL=https://alertproche.com)
    // Si tu utilises le ConfigService de NestJS, tu peux faire : this.configService.get('FRONTEND_URL')
    const baseUrl = process.env.FRONTEND_URL;

    // 2. Construction des URLs dynamiques
    const updateLocationUrl = `${baseUrl}/dashboard`; // Ajuste le chemin selon tes routes

    // 3. Rendu du template avec les bonnes variables
    const html = this.renderTemplate('locationUpdateMail', {
      pseudo,
      email: to,
      update_location_url: updateLocationUrl,
    });

    // 4. Envoi du mail avec un objet percutant
    return this.send({
      to,
      subject:
        '📍 Action requise : Mettez à jour votre localisation sur AlertProche',
      html,
    });
  }

  private renderTemplate(
    name: string,
    context: Record<string, string>,
  ): string {
    const path = join(this.templateDir, `${name}.hbs`);
    const source = fs.readFileSync(path, 'utf8');
    return handlebars.compile(source)(context);
  }

  private async send(opts: {
    to: string;
    subject: string;
    html: string;
  }): Promise<boolean> {
    try {
      await this.transporter.sendMail({
        from: '"AlertProche 🛡️" <tientcheuigorcarel@gmail.com>',
        ...opts,
      });
      this.logger.log(`📧 Email envoyé à ${opts.to}`);
      return true;
    } catch (err: any) {
      this.logger.error(`❌ Échec envoi email à ${opts.to}: ${err.message}`);
      return false;
    }
  }
}
