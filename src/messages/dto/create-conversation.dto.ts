import { IsString, IsMongoId, MaxLength } from 'class-validator';

export class CreateConversationDto {
  @IsString()
  @IsMongoId()
  recipientId: string;
}
