import { IsUUID, IsOptional, IsString, IsNumber, IsObject, IsDateString } from 'class-validator';

export class CreateEventDto {
  @IsUUID('4')
  sessionId: string;

  @IsUUID('4')
  visitorId: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  type: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsNumber()
  duration?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;

  @IsDateString()
  timestamp: string;
}
