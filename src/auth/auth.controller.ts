import { Controller, Post, Get, Patch, Body, UseGuards, Request, Headers } from '@nestjs/common';
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

class UpdatePseudoDto {
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  pseudo: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── ÉTAPE 1 : Envoyer OTP ────────────────────────────────────────
  @Post('otp/send')
  sendOtp(@Body() dto: SendOtpDto) {
    return this.authService.sendOtp(dto);
  }

  // ── ÉTAPE 2 : Vérifier OTP ───────────────────────────────────────
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  // ── ÉTAPE 3 : Finaliser inscription (pseudo + mot de passe) ──────
  @Post('register')
  register(
    @Body() dto: RegisterDto,
    @Headers('x-verify-token') verifyToken: string,
  ) {
    return this.authService.register(dto, verifyToken);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  // ── PROFIL ────────────────────────────────────────────────────────
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user._id.toString());
  }

  @Patch('profile/pseudo')
  @UseGuards(JwtAuthGuard)
  updatePseudo(@Request() req: any, @Body() body: UpdatePseudoDto) {
    return this.authService.updatePseudo(req.user._id.toString(), body.pseudo);
  }
}
