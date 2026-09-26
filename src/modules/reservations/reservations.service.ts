import { Inject, Injectable } from '@nestjs/common';
import { Actor } from '../../common/auth.util';
import { DomainError } from '../../common/errors';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { RESERVATION_REPOSITORY, ReservationRepository } from './reservations.repository';
import { ReservationDocument, ReservationStatus } from './entities/reservation.schema';

const ROLE_CUSTOMER = 'user';
const ROLE_MANAGER = 'manager';
const ROLE_ADMIN = 'admin';

/** How many parties a restaurant can seat in the same hour (POC capacity rule). */
const MAX_PARTIES_PER_HOUR = 10;

/** Service hours the storefront offers slots for (lunch, then dinner) — mirrors
 *  web-app's reservationSlots.ts, since there's no shared "opening hours"
 *  service yet. */
const SERVICE_HOURS = [12, 13, 19, 20, 21, 22];

export interface HourAvailability {
  hour: number;
  full: boolean;
}

/** Transitions a restaurant may apply to a reservation. */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  [ReservationStatus.Pending]: [ReservationStatus.Confirmed, ReservationStatus.Cancelled],
  [ReservationStatus.Confirmed]: [ReservationStatus.Seated, ReservationStatus.Cancelled, ReservationStatus.NoShow],
  [ReservationStatus.Seated]: [],
  [ReservationStatus.Cancelled]: [],
  [ReservationStatus.NoShow]: [],
};

/** All business rules live here — controllers stay presentational. */
@Injectable()
export class ReservationsService {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly repo: ReservationRepository,
  ) {}

  /** A customer books a table at a given restaurant. */
  async create(actor: Actor, dto: CreateReservationDto): Promise<ReservationDocument> {
    if (!actor.roles.includes(ROLE_CUSTOMER)) {
      throw DomainError.forbidden('only customers can book a table');
    }

    const reservationAt = new Date(dto.reservationAt);
    if (Number.isNaN(reservationAt.getTime())) {
      throw DomainError.validation('reservationAt is not a valid date');
    }
    if (reservationAt.getTime() <= Date.now()) {
      throw DomainError.validation('a reservation must be in the future');
    }

    // Capacity: cap the number of parties booked in the same hour.
    const booked = await this.countBookedInHour(dto.restaurantId, reservationAt);
    if (booked >= MAX_PARTIES_PER_HOUR) {
      throw DomainError.conflict('this restaurant is fully booked for that time slot');
    }

    return this.repo.create({
      restaurantId: dto.restaurantId,
      customerId: actor.userId,
      customerName: dto.customerName,
      phone: dto.phone ?? '',
      partySize: dto.partySize,
      reservationAt,
      notes: dto.notes ?? '',
      status: ReservationStatus.Pending,
    });
  }

  /** The customer's own reservations. */
  listMine(actor: Actor): Promise<ReservationDocument[]> {
    return this.repo.listByCustomer(actor.userId);
  }

  /** Which service hours are already fully booked for a restaurant on a given
   *  day — lets the storefront grey out full time slots before the customer
   *  even tries to book one. */
  async getAvailability(restaurantId: string, date: string): Promise<HourAvailability[]> {
    if (!restaurantId) {
      throw DomainError.validation('restaurantId is required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw DomainError.validation('date must be in YYYY-MM-DD format');
    }

    return Promise.all(
      SERVICE_HOURS.map(async (hour) => {
        const slot = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
        const booked = await this.countBookedInHour(restaurantId, slot);
        return { hour, full: booked >= MAX_PARTIES_PER_HOUR };
      }),
    );
  }

  /** The reservations of the manager's own restaurant (tenant-scoped). */
  listForMyRestaurant(actor: Actor, status?: ReservationStatus): Promise<ReservationDocument[]> {
    const restaurantId = this.requireOwnRestaurant(actor);
    return this.repo.listByRestaurant(restaurantId, status);
  }

  /** Detail — owner, the restaurant's manager, or head office. */
  async getById(actor: Actor, id: string): Promise<ReservationDocument> {
    const reservation = await this.getOrThrow(id);
    const allowed =
      actor.roles.includes(ROLE_ADMIN) ||
      reservation.customerId === actor.userId ||
      (actor.roles.includes(ROLE_MANAGER) && actor.tenantId === reservation.restaurantId);
    if (!allowed) {
      throw DomainError.forbidden('you are not allowed to view this reservation');
    }
    return reservation;
  }

  /** The restaurant confirms / seats / cancels a reservation. */
  async updateStatus(actor: Actor, id: string, target: ReservationStatus): Promise<ReservationDocument> {
    const restaurantId = this.requireOwnRestaurant(actor);
    const reservation = await this.getOrThrow(id);
    if (reservation.restaurantId !== restaurantId) {
      throw DomainError.forbidden('this reservation belongs to another restaurant');
    }
    if (!ALLOWED_TRANSITIONS[reservation.status].includes(target)) {
      throw DomainError.conflict(`cannot move a reservation from ${reservation.status} to ${target}`);
    }
    reservation.status = target;
    return this.repo.save(reservation);
  }

  /** A customer cancels their own reservation. */
  async cancelMine(actor: Actor, id: string): Promise<ReservationDocument> {
    const reservation = await this.getOrThrow(id);
    if (reservation.customerId !== actor.userId) {
      throw DomainError.forbidden('this reservation belongs to another customer');
    }
    if (!ALLOWED_TRANSITIONS[reservation.status].includes(ReservationStatus.Cancelled)) {
      throw DomainError.conflict(`a ${reservation.status} reservation can no longer be cancelled`);
    }
    reservation.status = ReservationStatus.Cancelled;
    return this.repo.save(reservation);
  }

  /** Active parties booked in the hour containing `at`, for capacity checks.
   *  Bucketed in UTC explicitly — relying on the server's local time here
   *  would silently disagree with getAvailability() outside a UTC-configured
   *  container. */
  private countBookedInHour(restaurantId: string, at: Date): Promise<number> {
    const hourStart = new Date(at);
    hourStart.setUTCMinutes(0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
    return this.repo.countOverlapping(restaurantId, hourStart, hourEnd);
  }

  private requireOwnRestaurant(actor: Actor): string {
    if (!actor.roles.includes(ROLE_MANAGER)) {
      throw DomainError.forbidden('only a restaurant manager can do this');
    }
    if (!actor.tenantId) {
      throw DomainError.forbidden('your account is not linked to a restaurant');
    }
    return actor.tenantId;
  }

  private async getOrThrow(id: string): Promise<ReservationDocument> {
    let reservation: ReservationDocument | null = null;
    try {
      reservation = await this.repo.findById(id);
    } catch {
      throw DomainError.notFound('reservation not found');
    }
    if (!reservation) {
      throw DomainError.notFound('reservation not found');
    }
    return reservation;
  }
}
