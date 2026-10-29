import mongoose, { Model } from 'mongoose';
import { MongooseReservationRepository } from './reservations.repository';
import { ReservationDocument, ReservationSchema, ReservationStatus } from './entities/reservation.schema';

/**
 * Runs against a real MongoDB:
 *   MONGO_TEST_URI=mongodb://localhost:27099/reservation_it npm run test:int
 */
const uri = process.env.MONGO_TEST_URI;
const describeIfMongo = uri ? describe : describe.skip;

describeIfMongo('MongooseReservationRepository (MongoDB)', () => {
  let repo: MongooseReservationRepository;
  let reservations: Model<ReservationDocument>;

  beforeAll(async () => {
    await mongoose.connect(uri as string);
    await mongoose.connection.dropDatabase();
    reservations = mongoose.model('Reservation', ReservationSchema) as unknown as Model<ReservationDocument>;
    repo = new MongooseReservationRepository(reservations, mongoose.connection);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  const slot = (minute: number) => {
    const start = new Date(Date.UTC(2030, 0, 1, 18, minute));
    return { restaurantId: 'resto-it', start, end: new Date(start.getTime() + 30 * 60_000) };
  };

  it('never oversells the last covers, even under concurrent bookings', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => repo.reserveCovers(slot(0), 4, 10)));

    expect(results.filter(Boolean)).toHaveLength(2); // 2 × 4 covers fit in 10, a third would not
  });

  it('starts the ledger from reservations made before it existed, and releases covers', async () => {
    await reservations.create({
      restaurantId: 'resto-it',
      customerId: 'c1',
      customerName: 'Legacy',
      partySize: 8,
      reservationAt: new Date(Date.UTC(2030, 0, 1, 18, 30)),
      status: ReservationStatus.Confirmed,
    });

    expect(await repo.reserveCovers(slot(30), 4, 10)).toBe(false);
    expect(await repo.reserveCovers(slot(30), 2, 10)).toBe(true);
    await repo.releaseCovers(slot(30), 2);
    expect(await repo.reserveCovers(slot(30), 2, 10)).toBe(true);
  });
});
