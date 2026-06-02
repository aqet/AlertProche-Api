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
    const user = this.config.get<string>('SMTP_USER') || 'tientcheuigorcarel@gmail.com';
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
  async sendOtpEmail(to: string, pseudo: string, code: string): Promise<boolean> {
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

  private renderTemplate(name: string, context: Record<string, string>): string {
    const path = join(this.templateDir, `${name}.hbs`);
    const source = fs.readFileSync(path, 'utf8');
    return handlebars.compile(source)(context);
  }

  private async send(opts: { to: string; subject: string; html: string }): Promise<boolean> {
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
