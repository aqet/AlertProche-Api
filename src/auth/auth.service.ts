import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../schemas/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    // Vérifier unicité email
    const emailExists = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (emailExists) {
      throw new ConflictException('Cette adresse email est déjà utilisée.');
    }

    // Vérifier unicité pseudo
    const pseudoExists = await this.userModel.findOne({ pseudo: dto.pseudo });
    if (pseudoExists) {
      throw new ConflictException('Ce pseudo est déjà pris.');
    }

    // Hacher le mot de passe
    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const user = await this.userModel.create({
      email: dto.email.toLowerCase(),
      password: hashedPassword,
      pseudo: dto.pseudo,
      role: 'Standard',
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.userModel.findOne({ email: dto.email.toLowerCase() });
    if (!user) {
      throw new UnauthorizedException('Email ou mot de passe incorrect.');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Email ou mot de passe incorrect.');
    }

    return this.buildAuthResponse(user);
  }

  async updatePseudo(userId: string, pseudo: string) {
    const exists = await this.userModel.findOne({ pseudo, _id: { $ne: userId } });
    if (exists) {
      throw new ConflictException('Ce pseudo est déjà pris.');
    }

    const user = await this.userModel.findByIdAndUpdate(
      userId,
      { pseudo },
      { new: true },
    ).select('-password');

    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  async getProfile(userId: string) {
    const user = await this.userModel.findById(userId).select('-password').lean();
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    return user;
  }

  private buildAuthResponse(user: UserDocument) {
    const payload = { sub: user._id.toString(), email: user.email, role: user.role };
    const access_token = this.jwtService.sign(payload);

    return {
      access_token,
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
