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
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
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
  @UseGuards(OptionalJwtAuthGuard)
  findAll(
    @Request() req: any,
    @Query('type') type?: string,
    @Query('location') location?: string,
    @Query('sort') sort?: 'reliability' | 'recent',
  ) {
    return this.postsService.findAll({
      type,
      location,
      sort,
      viewerId: req?.user?._id?.toString(),
    });
  }

  @Get('my-posts')
  @UseGuards(JwtAuthGuard)
  findMyPosts(@Request() req: any) {
    return this.postsService.findMyPosts(req.user._id.toString());
  }

  @Post('app-download')
  async incrementAppDownload() {
    return this.postsService.incrementAppDownload();
  }

  @Get('app-download')
  async getAppDownloadCount() {
    return this.postsService.getAppDownloadCount();
  }

  @Get('reported')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Moderateur', 'Admin')
  findReported() {
    return this.postsService.findReported();
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.postsService.findOne(id, req?.user?._id?.toString());
  }

  @Post('validate-city')
  @UseGuards(JwtAuthGuard)
  async validateCity(@Body('city') city: string) {
    if (!city || typeof city !== 'string' || !city.trim()) {
      throw new BadRequestException('Nom de ville manquant.');
    }
    return this.aiService.validateCityName(city.trim());
  }

  @Post('parse-audio')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('audio', {
    storage: memoryStorage(), // Uniquement en mémoire - aucun fichier sur le disque
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max
  }))
  async parseAudio(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Fichier audio manquant.');

    const allowedAudioMimes = ['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    if (!allowedAudioMimes.includes(file.mimetype)) {
      throw new BadRequestException(`Format audio non supporté : ${file.mimetype}`);
    }

    const result = await this.aiService.parseAudioToForm(file.buffer, file.mimetype);
    // Le buffer est libéré automatiquement par le GC - aucun stockage persistant
    return result;
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
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      fileFilter: imageFileFilter,
      limits: { fileSize: MAX_SIZE },
    }),
  )
  async searchByImage(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: any,
  ) {
    // Endpoint biométrique : réservé aux utilisateurs authentifiés
    // (protection contre l'utilisation anonyme comme moteur d'identification).
    if (!file) {
      throw new BadRequestException('Image manquante.');
    }
    if (file.size > MAX_SIZE) {
      throw new BadRequestException("L'image dépasse 5 Mo.");
    }

    return this.postsService.searchSimilarImages(
      file.buffer,
      file.mimetype,
      req.user?._id?.toString(),
    );
  }

  @Patch(':id/resolve')
  @UseGuards(JwtAuthGuard)
  resolvePost(@Param('id') id: string, @Request() req: any) {
    return this.postsService.resolvePost(id, req.user);
  }

  @Patch(':id/unresolve')
  @UseGuards(JwtAuthGuard)
  unresolvePost(@Param('id') id: string, @Request() req: any) {
    return this.postsService.unresolvePost(id, req.user);
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
  async report(@Param('id') id: string, @Body() body: ReportDto, @Request() req: any) {
    return await this.postsService.report(
      id,
      body.reason || 'Non précisé',
      req.user,
    );
  }

  /**
   * Vote de confirmation « Je confirme cette alerte ».
   * Bascule on/off : un second appel retire le vote.
   */
  @Post(':id/confirm')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id') id: string, @Request() req: any) {
    return this.postsService.confirm(id, req.user);
  }

  /** Incrémente le compteur de vues (appelé à l'ouverture de l'alerte). */
  @Post(':id/view')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerView(@Param('id') id: string) {
    await this.postsService.incrementView(id);
  }

  /**
   * Décision du staff : l'alerte est confirmée fausse.
   * Seul chemin vers la réputation négative (1 avertissement sur le compte).
   */
  @Patch(':id/false-alert')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('Moderateur', 'Admin')
  markFalseAlert(@Param('id') id: string, @Request() req: any) {
    return this.postsService.markFalseAlert(id, req.user);
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
