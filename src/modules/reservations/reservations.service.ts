import { Inject, Injectable } from '@nestjs/common';
import { Actor } from '../../common/auth.util';
import { DomainError } from '../../common/errors';
import { localParts, zonedInstant } from '../../common/time-zone';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { Page, RESERVATION_REPOSITORY, ReservationRepository, SEAT_HOLDING_STATUSES, Slot } from './reservations.repository';
import { ReservationDocument, ReservationStatus } from './entities/reservation.schema';
import { RestaurantsClient } from './restaurants.client';

const ROLE_CUSTOMER = 'user';
const ROLE_MANAGER = 'manager';
const ROLE_ADMIN = 'admin';

/** Bookable slots, in the restaurant's local time: lunch then dinner, every
 *  30 minutes (mirrors the storefront's reservationSlots.ts). */
const SLOT_MINUTES = 30;
const SERVICES = [
  { start: '12:00', end: '14:00' },
  { start: '19:00', end: '22:30' },
];

/** Bounds of the lists returned at once. */
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export interface SlotAvailability {
  /** HH:mm, local to the restaurant. */
  time: string;
  /** Kept for older storefronts that only read hours. */
  hour: number;
  full: boolean;
  remainingCovers: number;
}

/** Transitions a restaurant may apply to a reservation. */
const ALLOWED_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  [ReservationStatus.Pending]: [ReservationStatus.Confirmed, ReservationStatus.Cancelled],
  [ReservationStatus.Confirmed]: [ReservationStatus.Seated, ReservationStatus.Cancelled, ReservationStatus.NoShow],
  [ReservationStatus.Seated]: [],
  [ReservationStatus.Cancelled]: [],
  [ReservationStatus.NoShow]: [],
};

function slotTimes(): string[] {
  const times: string[] = [];
  for (const { start, end } of SERVICES) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    for (let m = sh * 60 + sm; m <= eh * 60 + em; m += SLOT_MINUTES) {
      times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    }
  }
  return times;
}

const SLOT_TIMES = slotTimes();

export function toPage(limit?: number, offset?: number): Page {
  const l = Number.isFinite(limit) && (limit as number) > 0 ? Math.min(limit as number, MAX_PAGE) : DEFAULT_PAGE;
  const o = Number.isFinite(offset) && (offset as number) > 0 ? (offset as number) : 0;
  return { limit: l, offset: o };
}

/** All business rules live here — controllers stay presentational. */
@Injectable()
export class ReservationsService {
  constructor(
    @Inject(RESERVATION_REPOSITORY) private readonly repo: ReservationRepository,
    private readonly restaurants: RestaurantsClient,
  ) {}

  /**
   * A customer books a table. The time must be one of the restaurant's slots
   * (in its own time zone), in the future, at an existing, active restaurant,
   * and the slot must still have enough covers — taken atomically, so two
   * customers can never both get the last table.
   */
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
    const restaurant = await this.restaurants.get(dto.restaurantId);
    if (!restaurant || !restaurant.isActive) {
      throw DomainError.validation('unknown or closed restaurant');
    }
    const local = localParts(reservationAt, restaurant.timeZone);
    if (!SLOT_TIMES.includes(local.time)) {
      throw DomainError.validation(`no service at ${local.time}: choose a lunch or dinner slot`);
    }

    const slot = this.slotOf(dto.restaurantId, reservationAt);
    if (!(await this.repo.reserveCovers(slot, dto.partySize, restaurant.seatingCapacity))) {
      throw DomainError.conflict('this restaurant is fully booked for that time slot');
    }
    try {
      return await this.repo.create({
        restaurantId: dto.restaurantId,
        customerId: actor.userId,
        customerName: dto.customerName,
        phone: dto.phone ?? '',
        partySize: dto.partySize,
        reservationAt,
        notes: dto.notes ?? '',
        status: ReservationStatus.Pending,
      });
    } catch (err) {
      await this.repo.releaseCovers(slot, dto.partySize);
      throw err;
    }
  }

  /** The customer's own reservations, most recent first. */
  listMine(actor: Actor, page: Page = toPage()): Promise<ReservationDocument[]> {
    return this.repo.listByCustomer(actor.userId, page);
  }

  /** Remaining covers of every slot of a day, in the restaurant's local time. */
  async getAvailability(restaurantId: string, date: string): Promise<SlotAvailability[]> {
    if (!restaurantId) {
      throw DomainError.validation('restaurantId is required');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw DomainError.validation('date must be in YYYY-MM-DD format');
    }
    const restaurant = await this.restaurants.get(restaurantId);
    if (!restaurant) {
      throw DomainError.notFound('restaurant not found');
    }
    return Promise.all(
      SLOT_TIMES.map(async (time) => {
        const start = zonedInstant(date, time, restaurant.timeZone);
        const covers = await this.repo.coversIn(this.slotOf(restaurantId, start));
        const remainingCovers = Math.max(0, restaurant.seatingCapacity - covers);
        return { time, hour: Number(time.slice(0, 2)), full: remainingCovers === 0, remainingCovers };
      }),
    );
  }

  /** A restaurant's reservations: managers their own, head office any. */
  async listForRestaurant(
    actor: Actor,
    restaurantId: string | undefined,
    status?: ReservationStatus,
    page: Page = toPage(),
  ): Promise<ReservationDocument[]> {
    const target = this.restaurantFor(actor, restaurantId);
    return this.repo.listByRestaurant(target, status, page);
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

  /** The restaurant (or head office) confirms / seats / cancels a reservation. */
  async updateStatus(actor: Actor, id: string, target: ReservationStatus): Promise<ReservationDocument> {
    const reservation = await this.getOrThrow(id);
    if (!actor.roles.includes(ROLE_ADMIN) && this.restaurantFor(actor, undefined) !== reservation.restaurantId) {
      throw DomainError.forbidden('this reservation belongs to another restaurant');
    }
    return this.move(reservation, target);
  }

  /** A customer cancels their own reservation. */
  async cancelMine(actor: Actor, id: string): Promise<ReservationDocument> {
    const reservation = await this.getOrThrow(id);
    if (reservation.customerId !== actor.userId) {
      throw DomainError.forbidden('this reservation belongs to another customer');
    }
    return this.move(reservation, ReservationStatus.Cancelled);
  }

  /** Applies a transition atomically and gives the seats back when it frees them. */
  private async move(reservation: ReservationDocument, target: ReservationStatus): Promise<ReservationDocument> {
    if (!ALLOWED_TRANSITIONS[reservation.status].includes(target)) {
      throw DomainError.conflict(`cannot move a reservation from ${reservation.status} to ${target}`);
    }
    const updated = await this.repo.transition(String(reservation._id), reservation.status, target);
    if (!updated) {
      throw DomainError.conflict('the reservation changed concurrently, retry');
    }
    if (SEAT_HOLDING_STATUSES.includes(reservation.status) && !SEAT_HOLDING_STATUSES.includes(target)) {
      await this.repo.releaseCovers(this.slotOf(reservation.restaurantId, reservation.reservationAt), reservation.partySize);
    }
    return updated;
  }

  /** The 30-minute slot containing an instant (slots are aligned on UTC half-hours, as every zone offset is). */
  private slotOf(restaurantId: string, at: Date): Slot {
    const start = new Date(Math.floor(at.getTime() / (SLOT_MINUTES * 60_000)) * SLOT_MINUTES * 60_000);
    return { restaurantId, start, end: new Date(start.getTime() + SLOT_MINUTES * 60_000) };
  }

  private restaurantFor(actor: Actor, requested: string | undefined): string {
    if (actor.roles.includes(ROLE_ADMIN)) {
      if (!requested) throw DomainError.validation('restaurantId is required');
      return requested;
    }
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
