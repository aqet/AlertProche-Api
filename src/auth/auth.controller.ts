import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IsString, MinLength, MaxLength } from 'class-validator';

class UpdatePseudoDto {
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  pseudo: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
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
