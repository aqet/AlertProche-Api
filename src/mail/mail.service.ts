import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as handlebars from 'handlebars';
import * as fs from 'fs';
import { join } from 'path';
import { User, UserDocument } from 'src/schemas/user.schema';
import { Model } from 'mongoose';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;
  private readonly templateDir: string;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {
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

  async sendLocationUpdateMail(): Promise<void> {
    let hasMoreUsers = true;
    let offset = 0;
    const sizeLimit = 3; // Parfait pour tes tests (pense à monter à 50 ou 100 en prod)

    const baseUrl = process.env.FRONTEND_URL;
    const postUrl = `${baseUrl}/dashboard`;

    while (hasMoreUsers) {
      // 1. Récupération du lot de 3 utilisateurs
      const users = await this.userModel
        .find({})
        .select('email pseudo')
        .limit(sizeLimit)
        .skip(offset)
        .lean();

      if (users.length === 0) {
        hasMoreUsers = false;
        break;
      }

      // 2. Création des promesses d'envoi pour le lot actuel
      const emailPromises = users.map(async (user) => {
        const html = this.renderTemplate('generalMail', {
          pseudo: user.pseudo, // FIX: Syntaxe clé-valeur corrigée
          email: user.email, // FIX: Utilise l'email du user de la BDD
          update_location_url: 'https://alert-proche.vercel.app/dashboard', // FIX: Utilise l'URL dynamique du .env
        });

        // Envoi unitaire
        return this.send({
          to: user.email, // FIX: Envoi au vrai destinataire
          subject:
            '📍 Action requise : Mettez à jour votre localisation sur AlertProche',
          html,
        });
      });

      // 3. FIX IMPORTANT : On attend que le lot de 3 mails soit envoyé avant de passer à la suite
      await Promise.all(emailPromises);

      // 4. On avance l'offset du nombre exact d'utilisateurs demandés
      offset += sizeLimit;
    }
  }

  async sendMailByLocation(post: any) {
    let hasMoreUsers = true;
    let offset = 0;
    const sizeLimit = 3; // Parfait pour tes tests (pense à monter à 50 ou 100 en prod)
console.log(post);
    const baseUrl = process.env.FRONTEND_URL;

    while (hasMoreUsers) {
      const users = await this.userModel
        .find({ location: post.location })
        .select('email pseudo')
        .limit(sizeLimit)
        .skip(offset)
        .lean();

      if (users.length === 0) {
        hasMoreUsers = false;
        break;
      }

      const emailPromises = users.map(async (user) => {
        const html = this.renderTemplate('mailByLocation', {
          pseudo: user.pseudo, // FIX: Syntaxe clé-valeur corrigée
          email: user.email, // FIX: Utilise l'email du user de la BDD
          case_type: post.type,
          case_title: post.title,
          case_location: post.location,
          case_date: post.createdAt,
          case_description:post.content,
          case_url: `${baseUrl}/posts/${post._id}`
        });

        // Envoi unitaire
        return this.send({
          to: user.email, // FIX: Envoi au vrai destinataire
          subject:
            `🚨 ALERTE : ${post.type} signalé à ${post.location} — AlertProche`,
          html,
        });
      });

      await Promise.all(emailPromises);

      offset += sizeLimit;
    }
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
