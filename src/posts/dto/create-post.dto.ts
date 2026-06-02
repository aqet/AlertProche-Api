import { IsString, IsEnum, IsBoolean, IsOptional, MinLength, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreatePostDto {
  @IsString()
  @MinLength(10, { message: 'Le titre doit contenir au moins 10 caractères.' })
  @MaxLength(150, { message: 'Le titre ne peut pas dépasser 150 caractères.' })
  title: string;

  @IsString()
  @MinLength(30, { message: 'La description doit contenir au moins 30 caractères.' })
  content: string;

  @IsString()
  @MinLength(2, { message: 'La localisation est requise.' })
  @MaxLength(100)
  location: string;

  @IsEnum(['Disparition', 'Abus', 'Prevention', 'Appel à l\'aide'], {
    message: 'Le type doit être Disparition, Abus, Prevention ou Appel à l\'aide.',
  })
  type: 'Disparition' | 'Abus' | 'Prevention' | 'Appel à l\'aide';

  // @IsOptional()
  // @IsBoolean()
  // @Transform(({ value }) => {
  //   if (value === 'true' || value === true) return true;
  //   if (value === 'false' || value === false || value === undefined || value === null) return false;
  //   return false;
  // })
  // isAnonymous?: boolean;
  @IsOptional()
  @IsString()
  // @Transform(({ value }) => {
  //   if (value === 'true' || value === true) return true;
  //   if (value === 'false' || value === false || value === undefined || value === null) return false;
  //   return false;
  // })
  isAnonymous?: string;
}
