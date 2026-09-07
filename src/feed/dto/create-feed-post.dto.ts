import { IsString, IsOptional, IsEnum, MaxLength, IsIn } from 'class-validator';

export class CreateFeedPostDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;
}
