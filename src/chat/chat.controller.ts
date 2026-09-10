import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /** POST /chat/message — utilisateur connecté, historique persisté */
  @Post('message')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  sendMessage(@Body() dto: SendMessageDto, @Req() req: any) {
    const userId   = req.user._id.toString();
    const userRole = req.user.role ?? 'Standard';
    return this.chatService.sendMessage(userId, userRole, dto);
  }

  /** GET /chat/history/:threadId — récupérer l'historique au chargement */
  @Get('history/:threadId')
  @UseGuards(JwtAuthGuard)
  getHistory(@Req() req: any) {
    const userId   = req.user._id.toString();
    const threadId = req.params.threadId;
    return this.chatService.getHistory(userId, threadId);
  }

  /** POST /chat/guest — visiteur non connecté, pas de stockage, rate limit IP */
  @Post('guest')
  @HttpCode(HttpStatus.OK)
  sendGuestMessage(@Body() dto: SendMessageDto, @Req() req: any) {
    // Identifier le visiteur par IP pour le rate limiting
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    return this.chatService.sendGuestMessage(ip, dto);
  }

  /** GET /chat/stats — statistiques d'utilisation du chatbot (Admin uniquement) */
  @Get('stats')
  @UseGuards(JwtAuthGuard)
  getStats(@Req() req: any) {
    // Accessible uniquement aux Admins
    if (req.user?.role !== 'Admin') {
      return { error: 'Accès non autorisé.' };
    }
    return this.chatService.getStats();
  }
}
