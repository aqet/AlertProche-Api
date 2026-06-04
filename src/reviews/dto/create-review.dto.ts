import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  message: string;

  @IsBoolean()
  @IsOptional()
  isAnonymous?: boolean;
}
