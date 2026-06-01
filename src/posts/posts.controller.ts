import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { IsString } from 'class-validator';

class ReportDto {
  @IsString()
  reason: string;
}

const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png'];
const MAX_SIZE = 5 * 1024 * 1024; // 5 Mo

// Multer : validation MIME avant écriture sur disque (via fileFilter)
const imageStorage = diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = join(process.cwd(), 'uploads', 'images');
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `post-${uniqueSuffix}${extname(file.originalname).toLowerCase()}`);
  },
});

function imageFileFilter(req: any, file: Express.Multer.File, cb: any) {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(
      new BadRequestException(
        `Format non supporté : ${file.mimetype}. Seuls JPG et PNG sont acceptés.`,
      ),
      false,
    );
  }
  cb(null, true);
}

@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findAll(@Query('type') type?: string, @Query('location') location?: string) {
    return this.postsService.findAll({ type, location });
  }

  @Get('my-posts')
  @UseGuards(JwtAuthGuard)
  findMyPosts(@Request() req: any) {
    return this.postsService.findMyPosts(req.user._id.toString());
  }

  @Get('reported')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Moderateur', 'Admin')
  findReported() {
    return this.postsService.findReported();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.postsService.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: imageStorage,
      fileFilter: imageFileFilter,
      limits: { fileSize: MAX_SIZE },
    }),
  )
  async create(
    @Body() dto: CreatePostDto,
    @Request() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    let imageUrl: string | undefined;
    if (file) {
      // Vérification taille (double sécurité)
      if (file.size > MAX_SIZE) {
        // Supprimer le fichier déjà écrit
        try { unlinkSync(file.path); } catch { /* ignore */ }
        throw new BadRequestException('L\'image dépasse 5 Mo. Veuillez choisir une image plus légère.');
      }
      imageUrl = `/uploads/images/${file.filename}`;
    }
    return this.postsService.create(dto, req.user, imageUrl);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() dto: UpdatePostDto, @Request() req: any) {
    return this.postsService.update(id, dto, req.user);
  }

  @Patch(':id/toggle-active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Moderateur', 'Admin')
  toggleActive(@Param('id') id: string, @Request() req: any) {
    return this.postsService.toggleActive(id, req.user);
  }

  @Post(':id/report')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  report(@Param('id') id: string, @Body() body: ReportDto) {
    return this.postsService.report(id, body.reason || 'Non précisé');
  }

  @Delete(':id/report')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Moderateur', 'Admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearReport(@Param('id') id: string, @Request() req: any) {
    return this.postsService.clearReport(id, req.user);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @Request() req: any) {
    return this.postsService.remove(id, req.user);
  }
}
