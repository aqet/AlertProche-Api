import { IsString, IsBoolean, IsOptional, MinLength } from 'class-validator';

export class CreateCommentDto {
  @IsString()
  @MinLength(10, { message: 'Le commentaire doit contenir au moins 10 caractères.' })
  content: string;

  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;
}
