import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Reservation, ReservationDocument, ReservationStatus } from './entities/reservation.schema';

/** Persistence port — the service depends on this interface so tests can swap
 *  in an in-memory fake without MongoDB. */
export interface ReservationRepository {
  create(data: Partial<Reservation>): Promise<ReservationDocument>;
  findById(id: string): Promise<ReservationDocument | null>;
  listByCustomer(customerId: string): Promise<ReservationDocument[]>;
  listByRestaurant(restaurantId: string, status?: ReservationStatus): Promise<ReservationDocument[]>;
  countOverlapping(restaurantId: string, from: Date, to: Date): Promise<number>;
  save(doc: ReservationDocument): Promise<ReservationDocument>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

@Injectable()
export class MongooseReservationRepository implements ReservationRepository {
  constructor(
    @InjectModel(Reservation.name) private readonly reservations: Model<ReservationDocument>,
  ) {}

  create(data: Partial<Reservation>): Promise<ReservationDocument> {
    return this.reservations.create(data);
  }

  findById(id: string): Promise<ReservationDocument | null> {
    return this.reservations.findById(id).exec();
  }

  listByCustomer(customerId: string): Promise<ReservationDocument[]> {
    return this.reservations.find({ customerId }).sort({ reservationAt: -1 }).exec();
  }

  listByRestaurant(restaurantId: string, status?: ReservationStatus): Promise<ReservationDocument[]> {
    const filter: Record<string, unknown> = { restaurantId };
    if (status) {
      filter.status = status;
    }
    return this.reservations.find(filter).sort({ reservationAt: 1 }).exec();
  }

  /** Active reservations overlapping a time window — used for capacity checks. */
  countOverlapping(restaurantId: string, from: Date, to: Date): Promise<number> {
    return this.reservations
      .countDocuments({
        restaurantId,
        status: { $in: [ReservationStatus.Pending, ReservationStatus.Confirmed, ReservationStatus.Seated] },
        reservationAt: { $gte: from, $lt: to },
      })
      .exec();
  }

  save(doc: ReservationDocument): Promise<ReservationDocument> {
    return doc.save();
  }
}
