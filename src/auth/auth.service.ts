import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../schemas/user.schema';
import { Otp, OtpDocument } from '../schemas/otp.schema';
import { MailService } from '../mail/mail.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    @InjectModel(Otp.name)  private otpModel:  Model<OtpDocument>,
    private jwtService: JwtService,
    private mailService: MailService,
  ) {}

  // ── ÉTAPE 1 : Vérifier email + pseudo, générer OTP ────────────────
  async sendOtp(dto: { email: string; pseudo: string }): Promise<{ message: string }> {
    const email = dto.email.toLowerCase();

    // Vérifier unicité
    if (await this.userModel.findOne({ email })) {
      throw new ConflictException('Cette adresse email est déjà utilisée.');
    }
    if (await this.userModel.findOne({ pseudo: dto.pseudo })) {
      throw new ConflictException('Ce pseudo est déjà pris.');
    }

    // Invalider les anciens OTP
    await this.otpModel.deleteMany({ email });

    // Générer code 5 chiffres
    const rawCode = String(Math.floor(10000 + Math.random() * 90000));
    const hashedCode = await bcrypt.hash(rawCode, 10);

    await this.otpModel.create({
      email,
      code: hashedCode,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
    });

    // Envoyer email
    await this.mailService.sendOtpEmail(email, dto.pseudo, rawCode);
    // await this.mailService.sendLocationUpdateMail();

    return { message: `Code OTP envoyé à ${email}. Valable 10 minutes.` };
  }

  // ── ÉTAPE 2 : Vérifier OTP ───────────────────────────────────────
  async verifyOtp(dto: { email: string; code: string }): Promise<{ verified: boolean; token: string }> {
    const email = dto.email.toLowerCase();
    const otp = await this.otpModel.findOne({ email, used: false }).sort({ createdAt: -1 });

    if (!otp) throw new BadRequestException('Code expiré ou introuvable. Recommencez.');
    if (otp.expiresAt < new Date()) {
      await this.otpModel.deleteMany({ email });
      throw new BadRequestException('Code expiré. Veuillez recommencer l\'inscription.');
    }

    const isValid = await bcrypt.compare(dto.code, otp.code);
    if (!isValid) throw new BadRequestException('Code incorrect. Vérifiez et réessayez.');

    // Marquer comme utilisé
    await this.otpModel.findByIdAndUpdate(otp._id, { used: true });

    // Générer un token temporaire de vérification (5 min)
    const verifyToken = this.jwtService.sign({ email, verified: true }, { expiresIn: '5m' });

    return { verified: true, token: verifyToken };
  }

  // ── ÉTAPE 3 : Finaliser l'inscription avec mot de passe ──────────
  async register(dto: RegisterDto, verifyToken: string): Promise<any> {
    // Valider le token de vérification
    let payload: any;
    try {
      payload = this.jwtService.verify(verifyToken);
    } catch {
      throw new UnauthorizedException('Session de vérification expirée. Recommencez l\'inscription.');
    }

    if (!payload.verified) {
      throw new UnauthorizedException('Email non vérifié.');
    }

    const email = payload.email;

    // Vérifier une dernière fois l'unicité
    if (await this.userModel.findOne({ email })) {
      throw new ConflictException('Cette adresse email est déjà utilisée.');
    }
    if (await this.userModel.findOne({ pseudo: dto.pseudo })) {
      throw new ConflictException('Ce pseudo est déjà pris.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const user = await this.userModel.create({
      email,
      password: hashedPassword,
      pseudo: dto.pseudo,
      role: 'Standard',
      location: dto.location
    });

    // Nettoyer les OTP
    await this.otpModel.deleteMany({ email });

    return this.buildAuthResponse(user);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────
  async login(dto: LoginDto): Promise<any> {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) throw new UnauthorizedException('Email ou mot de passe incorrect.');

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) throw new UnauthorizedException('Email ou mot de passe incorrect.');

    return this.buildAuthResponse(user);
  }

  // ── PROFIL ────────────────────────────────────────────────────────
  async updateAccount(userId: string, pseudo: string, location: string): Promise<any> {
    const exists = await this.userModel.findOne({ pseudo, _id: { $ne: userId } });
    if (exists) throw new ConflictException('Ce pseudo est déjà pris.');

    const user = await this.userModel
      .findByIdAndUpdate(userId, { pseudo, location }, { new: true })
      .select('-password');
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  async getProfile(userId: string): Promise<any> {
    const user = await this.userModel.findById(userId).select('-password').lean();
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  private buildAuthResponse(user: UserDocument): any {
    const payload = { sub: user._id.toString(), email: user.email, role: user.role };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        _id: user._id.toString(),
        email: user.email,
        pseudo: user.pseudo,
        role: user.role,
        createdAt: (user as any).createdAt,
      },
    };
  }
}
