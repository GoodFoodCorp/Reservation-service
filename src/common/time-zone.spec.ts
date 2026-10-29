import { localParts, zonedInstant } from './time-zone';

describe('time zones', () => {
  it('maps Paris wall-clock time to UTC in summer and winter', () => {
    expect(zonedInstant('2026-07-14', '19:30', 'Europe/Paris').toISOString()).toBe('2026-07-14T17:30:00.000Z');
    expect(zonedInstant('2026-12-24', '19:30', 'Europe/Paris').toISOString()).toBe('2026-12-24T18:30:00.000Z');
  });

  it('round-trips through localParts', () => {
    const instant = zonedInstant('2026-03-29', '12:00', 'Europe/Paris'); // DST change day
    expect(localParts(instant, 'Europe/Paris')).toEqual({ date: '2026-03-29', time: '12:00' });
  });

  it('reads an instant in the restaurant zone, not the server one', () => {
    expect(localParts(new Date('2026-07-14T10:00:00Z'), 'Europe/Paris')).toEqual({ date: '2026-07-14', time: '12:00' });
  });
});
