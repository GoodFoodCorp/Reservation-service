import { Actor } from '../../common/auth.util';
import { DomainErrorCode } from '../../common/errors';
import { zonedInstant } from '../../common/time-zone';
import { Reservation, ReservationDocument, ReservationStatus } from './entities/reservation.schema';
import { Page, ReservationRepository, SEAT_HOLDING_STATUSES, Slot } from './reservations.repository';
import { ReservationsService } from './reservations.service';
import { RestaurantInfo, RestaurantsClient } from './restaurants.client';

type FakeDoc = Reservation & { _id: string };

class FakeRepo implements ReservationRepository {
  docs = new Map<string, FakeDoc>();
  ledger = new Map<string, number>();
  private seq = 0;

  async create(data: Partial<Reservation>) {
    const doc = { _id: `r${String(++this.seq).padStart(23, '0')}`, ...data } as FakeDoc;
    this.docs.set(doc._id, doc);
    return { ...doc } as unknown as ReservationDocument;
  }
  async findById(id: string) {
    const d = this.docs.get(id);
    return (d ? { ...d } : null) as unknown as ReservationDocument | null;
  }
  async listByCustomer(customerId: string, page: Page) {
    return [...this.docs.values()].filter((d) => d.customerId === customerId).slice(page.offset, page.offset + page.limit) as unknown as ReservationDocument[];
  }
  async listByRestaurant(restaurantId: string, status: ReservationStatus | undefined, page: Page) {
    return [...this.docs.values()]
      .filter((d) => d.restaurantId === restaurantId && (!status || d.status === status))
      .slice(page.offset, page.offset + page.limit) as unknown as ReservationDocument[];
  }
  async coversIn(slot: Slot) {
    return [...this.docs.values()]
      .filter((d) => d.restaurantId === slot.restaurantId && d.reservationAt >= slot.start && d.reservationAt < slot.end && SEAT_HOLDING_STATUSES.includes(d.status))
      .reduce((s, d) => s + d.partySize, 0);
  }
  private key(slot: Slot) {
    return `${slot.restaurantId}:${slot.start.toISOString()}`;
  }
  async reserveCovers(slot: Slot, covers: number, capacity: number) {
    const current = this.ledger.get(this.key(slot)) ?? 0;
    if (current + covers > capacity) return false;
    this.ledger.set(this.key(slot), current + covers);
    return true;
  }
  async releaseCovers(slot: Slot, covers: number) {
    this.ledger.set(this.key(slot), Math.max(0, (this.ledger.get(this.key(slot)) ?? 0) - covers));
  }
  async transition(id: string, from: ReservationStatus, to: ReservationStatus) {
    const d = this.docs.get(id);
    if (!d || d.status !== from) return null;
    d.status = to;
    return { ...d } as unknown as ReservationDocument;
  }
}

class FakeRestaurants {
  info = new Map<string, RestaurantInfo>([
    ['resto-a', { isActive: true, seatingCapacity: 10, timeZone: 'Europe/Paris' }],
    ['resto-b', { isActive: true, seatingCapacity: 10, timeZone: 'Europe/Paris' }],
    ['closed', { isActive: false, seatingCapacity: 10, timeZone: 'Europe/Paris' }],
  ]);
  async get(id: string) {
    return this.info.get(id) ?? null;
  }
}

const RESTO_A = 'resto-a';
const RESTO_B = 'resto-b';

const customer: Actor = { userId: 'cust-1', tenantId: '', roles: ['user'], token: 't' };
const otherCustomer: Actor = { userId: 'cust-2', tenantId: '', roles: ['user'], token: 't' };
const managerA: Actor = { userId: 'mgr-a', tenantId: RESTO_A, roles: ['manager'], token: 't' };
const managerB: Actor = { userId: 'mgr-b', tenantId: RESTO_B, roles: ['manager'], token: 't' };
const admin: Actor = { userId: 'adm', tenantId: '', roles: ['admin'], token: 't' };

function tomorrow(): string {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Tomorrow at a Paris wall-clock time. */
function parisTomorrowAt(time: string): string {
  return zonedInstant(tomorrow(), time, 'Europe/Paris').toISOString();
}

function baseDto(overrides: Record<string, unknown> = {}) {
  return {
    restaurantId: RESTO_A,
    customerName: 'Marie Dupont',
    partySize: 4,
    reservationAt: parisTomorrowAt('19:30'),
    ...overrides,
  } as never;
}

function setup() {
  const repo = new FakeRepo();
  const restaurants = new FakeRestaurants();
  return { repo, restaurants, service: new ReservationsService(repo, restaurants as unknown as RestaurantsClient) };
}

async function expectError(promise: Promise<unknown>, code: DomainErrorCode) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('create', () => {
  it('books a table as PENDING for the acting customer', async () => {
    const { service } = setup();
    const r = await service.create(customer, baseDto());
    expect(r.status).toBe(ReservationStatus.Pending);
    expect(r.customerId).toBe('cust-1');
  });

  it('rejects non-customers, the past, unknown and closed restaurants', async () => {
    const { service } = setup();
    await expectError(service.create(managerA, baseDto()), DomainErrorCode.Forbidden);
    await expectError(service.create(customer, baseDto({ reservationAt: '2020-01-01T18:00:00.000Z' })), DomainErrorCode.Validation);
    await expectError(service.create(customer, baseDto({ restaurantId: 'nope' })), DomainErrorCode.Validation);
    await expectError(service.create(customer, baseDto({ restaurantId: 'closed' })), DomainErrorCode.Validation);
  });

  it('only accepts service slots, read in the restaurant time zone', async () => {
    const { service } = setup();
    await expectError(service.create(customer, baseDto({ reservationAt: parisTomorrowAt('03:00') })), DomainErrorCode.Validation);
    await expectError(service.create(customer, baseDto({ reservationAt: parisTomorrowAt('19:15') })), DomainErrorCode.Validation);
    await expect(service.create(customer, baseDto({ reservationAt: parisTomorrowAt('12:00') }))).resolves.toBeDefined();
  });

  it('counts covers, not bookings, against the dining room capacity', async () => {
    const { service } = setup();
    await service.create(customer, baseDto({ partySize: 6 }));
    await expectError(service.create(otherCustomer, baseDto({ partySize: 5 })), DomainErrorCode.Conflict);
    await expect(service.create(otherCustomer, baseDto({ partySize: 4 }))).resolves.toBeDefined();
  });

  it('gives the covers back when a booking is cancelled', async () => {
    const { service } = setup();
    const big = await service.create(customer, baseDto({ partySize: 10 }));
    await expectError(service.create(otherCustomer, baseDto({ partySize: 1 })), DomainErrorCode.Conflict);

    await service.cancelMine(customer, String(big._id));

    await expect(service.create(otherCustomer, baseDto({ partySize: 10 }))).resolves.toBeDefined();
  });
});

describe('getAvailability', () => {
  it('reports the remaining covers of each local slot', async () => {
    const { service } = setup();
    await service.create(customer, baseDto({ partySize: 10, reservationAt: parisTomorrowAt('20:00') }));

    const slots = await service.getAvailability(RESTO_A, tomorrow());

    expect(slots.find((s) => s.time === '20:00')).toMatchObject({ full: true, remainingCovers: 0, hour: 20 });
    expect(slots.find((s) => s.time === '20:30')).toMatchObject({ full: false, remainingCovers: 10 });
    expect(slots.map((s) => s.time)).toContain('12:00');
    expect(slots.map((s) => s.time)).toContain('22:30');
  });

  it('is scoped per restaurant and validates input', async () => {
    const { service } = setup();
    await service.create(customer, baseDto({ partySize: 10, reservationAt: parisTomorrowAt('20:00') }));
    const other = await service.getAvailability(RESTO_B, tomorrow());
    expect(other.every((s) => !s.full)).toBe(true);
    await expectError(service.getAvailability(RESTO_A, '01/08/2026'), DomainErrorCode.Validation);
    await expectError(service.getAvailability('nope', tomorrow()), DomainErrorCode.NotFound);
  });
});

describe('tenant isolation', () => {
  it("a manager only sees their own restaurant's reservations; head office any", async () => {
    const { service } = setup();
    await service.create(customer, baseDto({ restaurantId: RESTO_A }));
    await service.create(customer, baseDto({ restaurantId: RESTO_B }));

    expect(await service.listForRestaurant(managerA, RESTO_B)).toHaveLength(1); // their own, whatever is asked
    expect((await service.listForRestaurant(managerA, RESTO_B))[0].restaurantId).toBe(RESTO_A);
    expect(await service.listForRestaurant(admin, RESTO_B)).toHaveLength(1);
    await expectError(service.listForRestaurant(admin, undefined), DomainErrorCode.Validation);
  });

  it("a manager cannot change another restaurant's reservation, head office can", async () => {
    const { service } = setup();
    const r = await service.create(customer, baseDto({ restaurantId: RESTO_A }));
    await expectError(service.updateStatus(managerB, String(r._id), ReservationStatus.Confirmed), DomainErrorCode.Forbidden);
    await expect(service.updateStatus(admin, String(r._id), ReservationStatus.Confirmed)).resolves.toMatchObject({
      status: ReservationStatus.Confirmed,
    });
  });

  it('a customer cannot view someone else’s reservation', async () => {
    const { service } = setup();
    const r = await service.create(customer, baseDto());
    await expectError(service.getById(otherCustomer, String(r._id)), DomainErrorCode.Forbidden);
    await expect(service.getById(managerA, String(r._id))).resolves.toBeDefined();
  });
});

describe('status lifecycle', () => {
  it('PENDING → CONFIRMED → SEATED, and refuses an invalid transition', async () => {
    const { service } = setup();
    const r = await service.create(customer, baseDto());
    await service.updateStatus(managerA, String(r._id), ReservationStatus.Confirmed);
    const seated = await service.updateStatus(managerA, String(r._id), ReservationStatus.Seated);
    expect(seated.status).toBe(ReservationStatus.Seated);
    await expectError(service.updateStatus(managerA, String(r._id), ReservationStatus.Cancelled), DomainErrorCode.Conflict);
  });

  it('a no-show frees the covers', async () => {
    const { service, repo } = setup();
    const r = await service.create(customer, baseDto({ partySize: 10 }));
    await service.updateStatus(managerA, String(r._id), ReservationStatus.Confirmed);
    await service.updateStatus(managerA, String(r._id), ReservationStatus.NoShow);
    expect([...repo.ledger.values()]).toEqual([0]);
  });

  it('lets the customer cancel their own booking, once, and nobody else’s', async () => {
    const { service } = setup();
    const r = await service.create(customer, baseDto());
    await expectError(service.cancelMine(otherCustomer, String(r._id)), DomainErrorCode.Forbidden);
    await service.cancelMine(customer, String(r._id));
    await expectError(service.cancelMine(customer, String(r._id)), DomainErrorCode.Conflict);
  });
});
