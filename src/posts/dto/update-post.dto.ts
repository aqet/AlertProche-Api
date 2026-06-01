import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(150)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(30)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;
}
