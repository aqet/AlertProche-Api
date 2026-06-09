import { Controller, Post, Get, Patch, Body, UseGuards, Request } from '@nestjs/common';
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

class UpdatePseudoDto {
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  pseudo: string;
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

  // verifyToken dans le body — évite les problèmes de CORS sur les headers custom
  @Post('register')
  register(@Body() dto: RegisterWithTokenDto) {
    const { verifyToken, ...registerData } = dto;
    console.log({ verifyToken, registerData});
    
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

  @Patch('profile/pseudo')
  @UseGuards(JwtAuthGuard)
  updatePseudo(@Request() req: any, @Body() body: UpdatePseudoDto) {
    return this.authService.updatePseudo(req.user._id.toString(), body.pseudo);
  }
}
