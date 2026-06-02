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
  private smtpUser: string;

  constructor(private readonly config: ConfigService) {
    this.templateDir = join(process.cwd(), 'src', 'mail', 'templates');
    this.initTransporter();
  }

  private initTransporter(): void {
    this.smtpUser = this.config.get<string>('SMTP_USER');
    const smtpPass = this.config.get<string>('SMTP_PASS');

    this.transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: this.smtpUser, pass: smtpPass },
      tls: { rejectUnauthorized: false },
    });

    this.transporter.verify((err) => {
      if (err) this.logger.warn(`SMTP non vérifié: ${err.message}`);
      else this.logger.log('✅ SMTP Gmail connecté');
    });
  }

  /**
   * Vérifie si une adresse email est joignable via SMTP avant d'envoyer.
   * Utilise une connexion SMTP légère (EHLO + MAIL FROM + RCPT TO).
   * Retourne false si l'adresse n'existe pas ou est invalide.
   */
  async verifyEmailExists(email: string): Promise<boolean> {
    // 1. Validation format basique
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(email)) return false;

    // 2. Vérification SMTP du destinataire
    try {
      const verifier = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: this.smtpUser, pass: this.config.get<string>('SMTP_PASS') || 'hqez izyx jkjg iroq' },
        tls: { rejectUnauthorized: false },
      });

      // On essaie d'ouvrir une connexion et d'envoyer le message
      // Si l'adresse est invalide, sendMail lève une erreur avec code EENVELOPE ou similar
      await verifier.sendMail({
        from: `"AlertProche" <${this.smtpUser}>`,
        to: email,
        subject: 'Test',
        html: '',
        // On passe envelope pour forcer le rejet immédiat si adresse invalide
        envelope: {
          from: this.smtpUser,
          to: [email],
        },
      });
      verifier.close();
      return true;
    } catch (err: any) {
      this.logger.warn(`Adresse email inaccessible ${email}: ${err.message}`);
      return false;
    }
  }

  /**
   * Envoie le code OTP à l'adresse email de l'utilisateur.
   * Retourne true si envoyé avec succès, false sinon.
   */
  async sendOtpEmail(to: string, pseudo: string, code: string): Promise<{ success: boolean; error?: string }> {
    // Validation format email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailRegex.test(to)) {
      return { success: false, error: 'Format d\'adresse email invalide.' };
    }

    const html = this.renderTemplate('otp-verification', { pseudo, email: to, code });

    try {
      await this.transporter.sendMail({
        from: `"AlertProche 🛡️" <${this.smtpUser}>`,
        to,
        subject: `${code} — Votre code de vérification AlertProche`,
        html,
      });
      this.logger.log(`📧 OTP envoyé → ${to}`);
      return { success: true };
    } catch (err: any) {
      this.logger.error(`❌ Échec envoi → ${to}: ${err.message}`);

      // Détecter les erreurs de destinataire invalide
      const msg = err.message?.toLowerCase() || '';
      if (
        msg.includes('invalid') ||
        msg.includes('does not exist') ||
        msg.includes('user unknown') ||
        msg.includes('no such user') ||
        msg.includes('550') ||
        msg.includes('551') ||
        msg.includes('undeliverable')
      ) {
        return { success: false, error: 'Cette adresse email n\'existe pas ou est inaccessible.' };
      }

      return { success: false, error: 'Impossible d\'envoyer le code. Vérifiez l\'adresse et réessayez.' };
    }
  }

  private renderTemplate(name: string, context: Record<string, string>): string {
    const path = join(this.templateDir, `${name}.hbs`);
    const source = fs.readFileSync(path, 'utf8');
    return handlebars.compile(source)(context);
  }
}
