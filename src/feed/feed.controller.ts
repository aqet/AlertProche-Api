import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FeedService } from './feed.service';
import { CreateFeedPostDto } from './dto/create-feed-post.dto';

const ALLOWED_MIME = [
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'video/mp4', 'video/webm',
];

const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15 Mo (compression côté client avant)
const MAX_VIDEO_SIZE = 15 * 1024 * 1024; // 15 Mo

function feedFileFilter(req: any, file: Express.Multer.File, cb: any) {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(
      new BadRequestException(
        `Format non supporté : ${file.mimetype}. Acceptés : JPEG, PNG, WebP, MP4, WebM.`,
      ),
      false,
    );
  }
  cb(null, true);
}

@Controller('feed')
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  /** GET /feed?page=1&limit=10 */
  @Get()
  getFeed(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.feedService.getFeed(page, limit);
  }

  /** GET /feed/:id — récupérer un seul post (page de détail) */
  @Get(':id')
  getPostById(@Param('id') id: string) {
    return this.feedService.getPostById(id);
  }

  /** POST /feed — créer un post avec médias optionnels */
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FilesInterceptor('media', 4, {       // max 4 fichiers
      storage: memoryStorage(),
      fileFilter: feedFileFilter,
      limits: { fileSize: MAX_IMAGE_SIZE },
    }),
  )
  async createPost(
    @Body() dto: CreateFeedPostDto,
    @Req() req: any,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    // Vérification taille par type
    for (const file of files) {
      const isVideo = file.mimetype.startsWith('video/');
      const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
      if (file.size > maxSize) {
        throw new BadRequestException(
          `Fichier trop volumineux : ${file.originalname}. Max ${isVideo ? '15' : '15'} Mo.`,
        );
      }
    }

    return this.feedService.createPost(dto, req.user, files ?? []);
  }

  /** PATCH /feed/:id/like — liker / unliker */
  @Patch(':id/like')
  @UseGuards(JwtAuthGuard)
  toggleLike(@Param('id') id: string, @Req() req: any) {
    return this.feedService.toggleLike(id, req.user._id.toString());
  }

  /** DELETE /feed/:id */
  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  deletePost(@Param('id') id: string, @Req() req: any) {
    return this.feedService.deletePost(
      id,
      req.user._id.toString(),
      req.user.role,
    );
  }

  /** POST /feed/:id/share — incrémenter le compteur de partages */
  @Post(':id/share')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  sharePost(@Param('id') id: string) {
    return this.feedService.incrementShares(id);
  }

  /** GET /feed/:id/comments — lire les commentaires */
  @Get(':id/comments')
  getComments(@Param('id') id: string) {
    return this.feedService.getComments(id);
  }

  /** POST /feed/:id/comments — créer un commentaire */
  @Post(':id/comments')
  @UseGuards(JwtAuthGuard)
  addComment(
    @Param('id') id: string,
    @Body() body: { content: string },
    @Req() req: any,
  ) {
    if (!body.content?.trim()) throw new BadRequestException('Contenu vide.');
    return this.feedService.addFeedComment(
      id,
      req.user._id.toString(),
      req.user.pseudo,
      req.user.photoUrl || null,
      body.content.trim(),
    );
  }
}
