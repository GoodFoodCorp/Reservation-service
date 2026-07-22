import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateReservationDto {
  @ApiProperty({ description: 'Restaurant (tenant) id', format: 'uuid' })
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @ApiProperty({ example: 'Marie Dupont' })
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @ApiProperty({ example: '0601020304', required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ example: 4, minimum: 1, maximum: 20 })
  @IsInt()
  @Min(1)
  @Max(20)
  partySize: number;

  @ApiProperty({ example: '2026-08-01T19:30:00.000Z' })
  @IsDateString()
  reservationAt: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  notes?: string;
}
