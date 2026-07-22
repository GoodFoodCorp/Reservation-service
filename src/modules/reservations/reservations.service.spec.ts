import { Actor } from '../../common/auth.util';
import { DomainErrorCode } from '../../common/errors';
import { Reservation, ReservationDocument, ReservationStatus } from './entities/reservation.schema';
import { ReservationRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

type FakeDoc = Reservation & { _id: string; save: () => Promise<FakeDoc> };

class FakeRepo implements ReservationRepository {
  docs = new Map<string, FakeDoc>();
  private seq = 0;

  async create(data: Partial<Reservation>) {
    const doc = { _id: `r${String(++this.seq).padStart(23, '0')}`, ...data } as unknown as FakeDoc;
    doc.save = async () => doc;
    this.docs.set(doc._id, doc);
    return doc as unknown as ReservationDocument;
  }
  async findById(id: string) {
    return (this.docs.get(id) ?? null) as unknown as ReservationDocument | null;
  }
  async listByCustomer(customerId: string) {
    return [...this.docs.values()].filter((d) => d.customerId === customerId) as unknown as ReservationDocument[];
  }
  async listByRestaurant(restaurantId: string, status?: ReservationStatus) {
    return [...this.docs.values()].filter(
      (d) => d.restaurantId === restaurantId && (!status || d.status === status),
    ) as unknown as ReservationDocument[];
  }
  async countOverlapping(restaurantId: string, from: Date, to: Date) {
    return [...this.docs.values()].filter(
      (d) =>
        d.restaurantId === restaurantId &&
        d.reservationAt >= from &&
        d.reservationAt < to &&
        [ReservationStatus.Pending, ReservationStatus.Confirmed, ReservationStatus.Seated].includes(d.status),
    ).length;
  }
  async save(doc: ReservationDocument) {
    return doc;
  }
}

const RESTO_A = 'resto-a';
const RESTO_B = 'resto-b';

const customer: Actor = { userId: 'cust-1', tenantId: '', roles: ['user'], token: 't' };
const otherCustomer: Actor = { userId: 'cust-2', tenantId: '', roles: ['user'], token: 't' };
const managerA: Actor = { userId: 'mgr-a', tenantId: RESTO_A, roles: ['manager'], token: 't' };
const managerB: Actor = { userId: 'mgr-b', tenantId: RESTO_B, roles: ['manager'], token: 't' };

function tomorrowAt(hour: number): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function baseDto(overrides: Record<string, unknown> = {}) {
  return {
    restaurantId: RESTO_A,
    customerName: 'Marie Dupont',
    partySize: 4,
    reservationAt: tomorrowAt(19),
    ...overrides,
  } as never;
}

function setup() {
  const repo = new FakeRepo();
  return { repo, service: new ReservationsService(repo) };
}

async function expectError(promise: Promise<unknown>, code: DomainErrorCode) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('create', () => {
  it('books a table as PENDING for the acting customer', async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto());

    expect(res.status).toBe(ReservationStatus.Pending);
    expect(res.customerId).toBe('cust-1');
    expect(res.restaurantId).toBe(RESTO_A);
    expect(res.partySize).toBe(4);
  });

  it('rejects non-customers', async () => {
    const { service } = setup();
    await expectError(service.create(managerA, baseDto()), DomainErrorCode.Forbidden);
  });

  it('rejects a reservation in the past', async () => {
    const { service } = setup();
    await expectError(
      service.create(customer, baseDto({ reservationAt: '2020-01-01T19:00:00.000Z' })),
      DomainErrorCode.Validation,
    );
  });

  it('refuses when the time slot is fully booked', async () => {
    const { service } = setup();
    for (let i = 0; i < 10; i++) {
      await service.create(customer, baseDto());
    }
    await expectError(service.create(customer, baseDto()), DomainErrorCode.Conflict);
  });
});

describe('tenant isolation', () => {
  it("a manager only sees their own restaurant's reservations", async () => {
    const { service } = setup();
    await service.create(customer, baseDto({ restaurantId: RESTO_A }));
    await service.create(customer, baseDto({ restaurantId: RESTO_B }));

    const listA = await service.listForMyRestaurant(managerA);
    expect(listA).toHaveLength(1);
    expect(listA[0].restaurantId).toBe(RESTO_A);
  });

  it("a manager cannot change another restaurant's reservation", async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto({ restaurantId: RESTO_A }));

    await expectError(
      service.updateStatus(managerB, (res as never as FakeDoc)._id, ReservationStatus.Confirmed),
      DomainErrorCode.Forbidden,
    );
  });

  it('a customer cannot view someone else’s reservation', async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto());

    await expectError(
      service.getById(otherCustomer, (res as never as FakeDoc)._id),
      DomainErrorCode.Forbidden,
    );
    await expect(service.getById(customer, (res as never as FakeDoc)._id)).resolves.toBeDefined();
    await expect(service.getById(managerA, (res as never as FakeDoc)._id)).resolves.toBeDefined();
  });
});

describe('status lifecycle', () => {
  it('PENDING → CONFIRMED → SEATED', async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto());
    const id = (res as never as FakeDoc)._id;

    const confirmed = await service.updateStatus(managerA, id, ReservationStatus.Confirmed);
    expect(confirmed.status).toBe(ReservationStatus.Confirmed);

    const seated = await service.updateStatus(managerA, id, ReservationStatus.Seated);
    expect(seated.status).toBe(ReservationStatus.Seated);
  });

  it('refuses an invalid transition', async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto());
    const id = (res as never as FakeDoc)._id;

    // PENDING cannot go straight to SEATED
    await expectError(
      service.updateStatus(managerA, id, ReservationStatus.Seated),
      DomainErrorCode.Conflict,
    );
  });

  it('lets the customer cancel their own booking, once', async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto());
    const id = (res as never as FakeDoc)._id;

    const cancelled = await service.cancelMine(customer, id);
    expect(cancelled.status).toBe(ReservationStatus.Cancelled);

    await expectError(service.cancelMine(customer, id), DomainErrorCode.Conflict);
  });

  it('a customer cannot cancel someone else’s booking', async () => {
    const { service } = setup();
    const res = await service.create(customer, baseDto());
    await expectError(
      service.cancelMine(otherCustomer, (res as never as FakeDoc)._id),
      DomainErrorCode.Forbidden,
    );
  });
});
