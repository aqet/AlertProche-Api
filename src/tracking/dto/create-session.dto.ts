import { IsUUID, IsOptional, IsString, IsIn, IsBoolean, IsDateString } from 'class-validator';

export class CreateSessionDto {
  @IsUUID('4')
  sessionId: string;

  @IsUUID('4')
  visitorId: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsIn(['mobile', 'tablet', 'desktop'])
  device: string;

  @IsString()
  browser: string;

  @IsString()
  os: string;

  @IsString()
  entryPage: string;

  @IsIn(['Direct', 'Organic Search', 'Social', 'Referral', 'Unknown'])
  trafficSource: string;

  @IsBoolean()
  isNewVisitor: boolean;

  @IsDateString()
  startedAt: string;
}
