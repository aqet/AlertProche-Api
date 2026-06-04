import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt.guard';

@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /** GET /reviews?page=1&limit=10 — public */
  @Get()
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 10,
  ) {
    const { reviews, total } = await this.reviewsService.findAll(+page, +limit);
    return { reviews, total, page: +page, limit: +limit };
  }

  /** GET /reviews/stats — public */
  @Get('stats')
  async getStats() {
    return this.reviewsService.getStats();
  }

  /** POST /reviews — auth optionnel (les anonymes sont acceptés) */
  @UseGuards(OptionalJwtAuthGuard)
  @Post()
  async create(@Body() dto: CreateReviewDto, @Request() req: any) {
    const userId = req.user?._id ?? req.user?.sub ?? undefined;
    const pseudo = req.user?.pseudo ?? undefined;
    return this.reviewsService.create(dto, userId, pseudo);
  }
}
