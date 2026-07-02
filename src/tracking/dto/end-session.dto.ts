import { IsString, IsNumber } from 'class-validator';

export class EndSessionDto {
  @IsString()
  exitPage: string;

  @IsNumber()
  duration: number;
}
