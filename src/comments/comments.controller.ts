import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  // GET /comments/post/:postId — Commentaires d'une publication
  @Get('post/:postId')
  findByPost(@Param('postId') postId: string) {
    return this.commentsService.findByPost(postId);
  }

  // GET /comments/my-comments — Mes commentaires
  @Get('my-comments')
  @UseGuards(JwtAuthGuard)
  findMyComments(@Request() req: any) {
    return this.commentsService.findMyComments(req.user._id.toString());
  }

  // POST /comments/post/:postId — Créer un commentaire
  @Post('post/:postId')
  @UseGuards(JwtAuthGuard)
  create(
    @Param('postId') postId: string,
    @Body() dto: CreateCommentDto,
    @Request() req: any,
  ) {
    return this.commentsService.create(postId, dto, req.user);
  }

  // DELETE /comments/:id — Supprimer un commentaire
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.commentsService.remove(id, req.user);
  }
}
