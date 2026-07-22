import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { ReservationStatus } from '../entities/reservation.schema';

export class UpdateStatusDto {
  @ApiProperty({ enum: ReservationStatus })
  @IsEnum(ReservationStatus)
  status: ReservationStatus;
}
