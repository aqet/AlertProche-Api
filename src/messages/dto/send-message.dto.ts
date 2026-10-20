import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @MinLength(1, { message: 'Le message ne peut pas être vide.' })
  @MaxLength(2000)
  text: string;
}
