import { Controller, Post, Get, Patch, Body, UseGuards, Request, Req, Query, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { IsEmail, IsString, MinLength, MaxLength, Length } from 'class-validator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

class SendOtpDto {
  @IsEmail({}, { message: 'Email invalide.' })
  email: string;

  @IsString()
  @MinLength(3)
  @MaxLength(30)
  pseudo: string;
} 

class VerifyOtpDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(5, 5, { message: 'Le code doit contenir exactement 5 chiffres.' })
  code: string;
}

class RegisterWithTokenDto extends RegisterDto {
  @IsString()
  verifyToken: string;
}

class SaveTokenDto {
  @IsString()
  token: string;
}

class UpdateAccoumtDto {
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  pseudo: string;

  @IsString()
  location: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('otp/send')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  // verifyToken dans le body - évite les problèmes de CORS sur les headers custom
  @Post('register')
  register(@Body() dto: RegisterWithTokenDto) {
    const { verifyToken, ...registerData } = dto;
    
    return this.authService.register(registerData, verifyToken);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user._id.toString());
  }

  @Patch('profile/Account')
  @UseGuards(JwtAuthGuard)
  updateAccount(@Request() req: any, @Body() body: UpdateAccoumtDto) {
    return this.authService.updateAccount(req.user._id.toString(), body.pseudo, body.location);
  }

  @UseGuards(JwtAuthGuard)
  @Post('fcm-token')
  async addToken(@Req() req, @Body() dto: SaveTokenDto) {
    const userId = req.user?._id?.toString?.();
    if (!userId) {
      throw new UnauthorizedException('Utilisateur non authentifié.');
    }

    const user = await this.authService.registerFcmToken(userId, dto.token);
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable pour enregistrement du token.');
    }

    return { message: 'Token enregistré avec succès', token: user.token };
  }

  /** GET /auth/vapid-public-key - Clé VAPID publique pour Web Push */
  @Get('vapid-public-key')
  getVapidPublicKey() {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return { key: null };
    return { key };
  }

  /** GET /auth/users/search?q=pseudo - Rechercher des utilisateurs par pseudo */
  @Get('users/search')
  @UseGuards(JwtAuthGuard)
  searchUsers(@Query('q') q: string, @Req() req: any) {
    if (!q || q.trim().length < 2) return [];
    return this.authService.searchUsers(q.trim(), req.user._id.toString());
  }
}
