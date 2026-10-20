import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MessagesService } from './messages.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  /** POST /messages/conversations - créer/récupérer un fil avec un utilisateur */
  @Post('conversations')
  createConversation(@Body() dto: CreateConversationDto, @Req() req: any) {
    const meId = req.user._id.toString();
    return this.messagesService.getOrCreateConversation(meId, dto.recipientId);
  }

  /** GET /messages/conversations - boîte de réception */
  @Get('conversations')
  listConversations(@Req() req: any) {
    const meId = req.user._id.toString();
    return this.messagesService.listConversations(meId);
  }

  /** GET /messages/conversations/:id/messages?since=&limit= - messages (polling delta) */
  @Get('conversations/:id/messages')
  getMessages(
    @Param('id') id: string,
    @Query('since') since: string | undefined,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Req() req: any,
  ) {
    const meId = req.user._id.toString();
    return this.messagesService.getMessages(meId, id, since, limit);
  }

  /** POST /messages/conversations/:id/messages - envoyer un message */
  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.OK)
  sendMessage(@Param('id') id: string, @Body() dto: SendMessageDto, @Req() req: any) {
    const meId = req.user._id.toString();
    return this.messagesService.sendMessage(meId, id, dto.text);
  }

  /** POST /messages/conversations/:id/read - marquer la conversation comme lue */
  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Param('id') id: string, @Req() req: any) {
    const meId = req.user._id.toString();
    return this.messagesService.markRead(meId, id);
  }

  /** GET /messages/unread-total - badge navbar */
  @Get('unread-total')
  unreadTotal(@Req() req: any) {
    const meId = req.user._id.toString();
    return this.messagesService.unreadTotal(meId);
  }
}
