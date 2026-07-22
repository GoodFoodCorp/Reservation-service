import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Reservation, ReservationSchema } from './entities/reservation.schema';
import { ReservationsController } from './reservations.controller';
import { RESERVATION_REPOSITORY, MongooseReservationRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Reservation.name, schema: ReservationSchema }])],
  controllers: [ReservationsController],
  providers: [
    ReservationsService,
    { provide: RESERVATION_REPOSITORY, useClass: MongooseReservationRepository },
  ],
})
export class ReservationsModule {}
