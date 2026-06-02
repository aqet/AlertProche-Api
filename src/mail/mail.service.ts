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
  private fromAddress: string;

  constructor(private readonly config: ConfigService) {
    this.templateDir = join(process.cwd(), 'src', 'mail', 'templates');
    this.initTransporter();
  }

  private initTransporter(): void {
    const smtpUser = this.config.get<string>('SMTP_USER') || 'tientcheuigorcarel@gmail.com';
    const smtpPass = this.config.get<string>('SMTP_PASS') || 'hqez izyx jkjg iroq';

    // L'expéditeur doit être l'adresse Gmail authentifiée
    this.fromAddress = `"AlertProche 🛡️" <${smtpUser}>`;

    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: smtpUser, pass: smtpPass },
      tls: { rejectUnauthorized: false },
    });

    this.transporter.verify((err) => {
      if (err) this.logger.warn(`SMTP non vérifié: ${err.message}`);
      else this.logger.log('✅ SMTP Gmail connecté');
    });
  }

  /**
   * Envoie le code OTP à l'adresse email de l'utilisateur.
   * Retourne true si envoyé, false si l'adresse est invalide ou l'envoi échoue.
   */
  async sendOtpEmail(to: string, pseudo: string, code: string): Promise<boolean> {
    const html = this.renderTemplate('otp-verification', { pseudo, email: to, code });
    return this.send({
      to,   // envoi à l'adresse de l'utilisateur, pas à l'admin
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
        from: this.fromAddress,  // expéditeur = compte Gmail configuré
        to: opts.to,             // destinataire = adresse de l'utilisateur
        subject: opts.subject,
        html: opts.html,
      });
      this.logger.log(`📧 OTP envoyé → ${opts.to}`);
      return true;
    } catch (err: any) {
      this.logger.error(`❌ Échec envoi → ${opts.to}: ${err.message}`);
      // Erreur typique pour adresse invalide : "invalid recipient"
      return false;
    }
  }
}
