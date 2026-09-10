import { IsString, IsNotEmpty, MaxLength, MinLength, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty({ message: 'Le message ne peut pas être vide.' })
  @MinLength(1)
  @MaxLength(500, { message: 'Message trop long (500 caractères max).' })
  // Sanitiser pour neutraliser les tentatives de prompt injection
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .replace(/<[^>]*>/g, '')           // strip HTML
          .replace(/\[INST\]|\[\/INST\]/gi, '') // strip LLM markers
          .replace(/###|```system|<\|system\|>/gi, '') // strip system markers
          .trim()
      : value,
  )
  message: string;

  @IsString()
  @IsNotEmpty()
  threadId: string;
}
