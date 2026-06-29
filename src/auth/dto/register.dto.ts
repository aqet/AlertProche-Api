import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

/**
 * À l'étape 3, l'email vient du token de vérification OTP.
 * On ne demande plus que le pseudo et le mot de passe.
 */
export class RegisterDto {
  @IsString()
  @MinLength(3, { message: 'Le pseudo doit contenir au moins 3 caractères.' })
  @MaxLength(30, { message: 'Le pseudo ne peut pas dépasser 30 caractères.' })
  // @Matches(/^[a-zA-Z0-9_\-\.]+$/, {
  //   message: 'Le pseudo ne peut contenir que des lettres, chiffres, tirets et underscores.',
  // })
  pseudo: string;

  @IsString() 
  @MinLength(6, { message: 'Le mot de passe doit contenir au moins 6 caractères.' })
  password: string;

  @IsString()
  location: string
}
