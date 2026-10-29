import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Reservation, ReservationDocument, ReservationStatus } from './entities/reservation.schema';

/** Statuses that hold seats. */
export const SEAT_HOLDING_STATUSES = [ReservationStatus.Pending, ReservationStatus.Confirmed, ReservationStatus.Seated];

export interface Page {
  limit: number;
  offset: number;
}

/** A reservation slot of a restaurant: [start, end). */
export interface Slot {
  restaurantId: string;
  start: Date;
  end: Date;
}

/** Persistence port — the service depends on this interface so tests can swap
 *  in an in-memory fake without MongoDB. */
export interface ReservationRepository {
  create(data: Partial<Reservation>): Promise<ReservationDocument>;
  findById(id: string): Promise<ReservationDocument | null>;
  listByCustomer(customerId: string, page: Page): Promise<ReservationDocument[]>;
  listByRestaurant(restaurantId: string, status: ReservationStatus | undefined, page: Page): Promise<ReservationDocument[]>;
  /** Covers held in a slot by active reservations. */
  coversIn(slot: Slot): Promise<number>;
  /**
   * Atomically takes `covers` seats in the slot if `capacity` allows it.
   * Two customers booking the last table at once cannot both succeed.
   */
  reserveCovers(slot: Slot, covers: number, capacity: number): Promise<boolean>;
  releaseCovers(slot: Slot, covers: number): Promise<void>;
  /** Moves a reservation from one status to another; null if it changed meanwhile. */
  transition(id: string, from: ReservationStatus, to: ReservationStatus): Promise<ReservationDocument | null>;
}

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

interface SlotDoc {
  _id: string;
  covers: number;
}

function slotKey(slot: Slot): string {
  return `${slot.restaurantId}:${slot.start.toISOString()}`;
}

@Injectable()
export class MongooseReservationRepository implements ReservationRepository {
  constructor(
    @InjectModel(Reservation.name) private readonly reservations: Model<ReservationDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private get slots() {
    return this.connection.collection<SlotDoc>('reservation_slots');
  }

  create(data: Partial<Reservation>): Promise<ReservationDocument> {
    return this.reservations.create(data);
  }

  findById(id: string): Promise<ReservationDocument | null> {
    return this.reservations.findById(id).exec();
  }

  listByCustomer(customerId: string, page: Page): Promise<ReservationDocument[]> {
    return this.reservations.find({ customerId }).sort({ reservationAt: -1 }).skip(page.offset).limit(page.limit).exec();
  }

  listByRestaurant(restaurantId: string, status: ReservationStatus | undefined, page: Page): Promise<ReservationDocument[]> {
    const filter: Record<string, unknown> = { restaurantId };
    if (status) filter.status = status;
    return this.reservations.find(filter).sort({ reservationAt: 1 }).skip(page.offset).limit(page.limit).exec();
  }

  async coversIn(slot: Slot): Promise<number> {
    const [row] = await this.reservations
      .aggregate<{ covers: number }>([
        {
          $match: {
            restaurantId: slot.restaurantId,
            status: { $in: SEAT_HOLDING_STATUSES },
            reservationAt: { $gte: slot.start, $lt: slot.end },
          },
        },
        { $group: { _id: null, covers: { $sum: '$partySize' } } },
      ])
      .exec();
    return row?.covers ?? 0;
  }

  async reserveCovers(slot: Slot, covers: number, capacity: number): Promise<boolean> {
    const _id = slotKey(slot);
    for (let attempt = 0; attempt < 3; attempt++) {
      const taken = await this.slots.findOneAndUpdate(
        { _id, covers: { $lte: capacity - covers } },
        { $inc: { covers } },
        { returnDocument: 'after' },
      );
      if (taken) return true;
      if (await this.slots.findOne({ _id })) return false; // full
      // First booking of the slot: start the counter from the reservations
      // made before the ledger existed.
      try {
        await this.slots.insertOne({ _id, covers: await this.coversIn(slot) });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err; // concurrent first booking: retry
      }
    }
    return false;
  }

  async releaseCovers(slot: Slot, covers: number): Promise<void> {
    await this.slots.updateOne({ _id: slotKey(slot), covers: { $gte: covers } }, { $inc: { covers: -covers } });
  }

  transition(id: string, from: ReservationStatus, to: ReservationStatus): Promise<ReservationDocument | null> {
    return this.reservations.findOneAndUpdate({ _id: id, status: from }, { $set: { status: to } }, { new: true }).exec();
  }
}
