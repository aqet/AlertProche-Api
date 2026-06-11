import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, Request,
  UseInterceptors, UploadedFile,
  HttpCode, HttpStatus, BadRequestException, HttpException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CloudinaryService } from '../common/cloudinary/cloudinary.service';
import { IsNotEmpty, isString, IsString } from 'class-validator';
import { AiService } from 'src/ai/ai.service';

class ReportDto {
  @IsString()
  reason: string;
}

export class AnalyzeImageDto {
  @IsString()
  @IsNotEmpty()
  image: string;    // La chaîne Base64 complète envoyée par Angular
  
  @IsString()
  @IsNotEmpty()
  mimeType: string; // ex: "image/jpeg"
}

const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5 Mo

function imageFileFilter(req: any, file: Express.Multer.File, cb: any) {
  if (!ALLOWED_MIME.includes(file.mimetype)) {
    return cb(new BadRequestException(
      `Format non supporté : ${file.mimetype}. Seuls JPG, PNG et WebP sont acceptés.`
    ), false);
  }
  cb(null, true);
}

@Controller('posts')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly cloudinary: CloudinaryService,
    private readonly aiService: AiService
  ) {}

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

  @Post('analyze-image')
  @UseGuards(JwtAuthGuard)
  async analyzeImageForCompletion(@Body() body: AnalyzeImageDto) {
    
    if (!body.image) throw new HttpException('Image Base64 manquante.', HttpStatus.BAD_REQUEST);

    // 💡 SÉCURITÉ : Nettoyer la chaîne Base64 si le frontend envoie le préfixe 'data:image/...;base64,'
    let base64Data = body.image;
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',')[1];
    }

    const completion = await this.aiService.autocompleteFormFromImage(base64Data, body.mimeType);
    
    return { success: true, completion: completion };
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', {
    storage: memoryStorage(),   // Buffer en mémoire → Cloudinary
    fileFilter: imageFileFilter,
    limits: { fileSize: MAX_SIZE },
  }))
  async create(
    @Body() dto: CreatePostDto,
    @Request() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    let imageUrl: string | undefined;

    if (file) {
      // Vérification taille
      if (file.size > MAX_SIZE) {
        throw new BadRequestException('L\'image dépasse 5 Mo.');
      }
      // Upload vers Cloudinary
      imageUrl = await this.cloudinary.uploadBuffer(file.buffer, file.originalname);
    }

    return this.postsService.create(dto, req.user, file, imageUrl);
  }

  @Post('search-by-image')
  @UseInterceptors(FileInterceptor('image')) // Intercepte le fichier nommé 'image'
  async searchByImage(@UploadedFile() file: Express.Multer.File) {
    
    // 💡 Ici, 'file.buffer' contient tes octets bruts (ex: <Buffer 89 50 4e 47...>)
    // On passe le buffer et le type (image/png) au service
    return this.postsService.searchSimilarImages(file.buffer, file.mimetype);
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
  // @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Param('id') id: string, @Body() body: ReportDto) {
    return await this.postsService.report(id, body.reason || 'Non précisé');
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
  async remove(@Param('id') id: string, @Request() req: any) {
    // Récupérer l'URL avant suppression pour nettoyer Cloudinary
    const post = await this.postsService.findOne(id);
    await this.postsService.remove(id, req.user);
    if (post?.image_url) {
      await this.cloudinary.deleteByUrl(post.image_url);
    }
  }
}
