import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Review, ReviewDocument } from '../schemas/review.schema';
import { CreateReviewDto } from './dto/create-review.dto';

export interface ReviewStats {
  average: number;
  total: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel(Review.name) private reviewModel: Model<ReviewDocument>,
  ) {}

  async create(
    dto: CreateReviewDto,
    userId?: string,
    pseudo?: string,
  ): Promise<ReviewDocument> {
    const review = new this.reviewModel({
      rating: dto.rating,
      message: dto.message,
      isAnonymous: dto.isAnonymous ?? false,
      author_id: userId ?? null,
      pseudo: dto.isAnonymous ? null : (pseudo ?? null),
    });
    return review.save();
  }

  async findAll(page = 1, limit = 10): Promise<{ reviews: ReviewDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const [reviews, total] = await Promise.all([
      this.reviewModel
        .find({ isVisible: true })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.reviewModel.countDocuments({ isVisible: true }),
    ]);
    return { reviews, total };
  }

  async getStats(): Promise<ReviewStats> {
    const agg = await this.reviewModel.aggregate([
      { $match: { isVisible: true } },
      {
        $group: {
          _id: null,
          average: { $avg: '$rating' },
          total: { $sum: 1 },
          r1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
          r2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
          r3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
          r4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
          r5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        },
      },
    ]);

    if (!agg.length) {
      return { average: 0, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    }

    const { average, total, r1, r2, r3, r4, r5 } = agg[0];
    return {
      average: Math.round(average * 10) / 10,
      total,
      distribution: { 1: r1, 2: r2, 3: r3, 4: r4, 5: r5 },
    };
  }
}
