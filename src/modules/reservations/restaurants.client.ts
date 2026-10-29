import { Injectable, Logger } from '@nestjs/common';

/** What reservations need to know about a restaurant. */
export interface RestaurantInfo {
  isActive: boolean;
  /** Covers the dining room seats per reservation slot. */
  seatingCapacity: number;
  timeZone: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;
export const DEFAULT_TIME_ZONE = 'Europe/Paris';
export const DEFAULT_SEATING_CAPACITY = 40;

/** Reads restaurants from franchise-service's public API, with a short cache. */
@Injectable()
export class RestaurantsClient {
  private readonly logger = new Logger(RestaurantsClient.name);
  private readonly cache = new Map<string, { value: RestaurantInfo | null; expiresAt: number }>();

  private get baseUrl(): string {
    return (process.env.FRANCHISE_SERVICE_URL ?? 'http://franchise-service:8089').replace(/\/+$/, '');
  }

  /**
   * null when the restaurant does not exist. When franchise-service cannot be
   * reached, the defaults are returned (bookings keep working).
   */
  async get(restaurantId: string): Promise<RestaurantInfo | null> {
    const hit = this.cache.get(restaurantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    try {
      const res = await fetch(`${this.baseUrl}/api/restaurants/${encodeURIComponent(restaurantId)}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 400) {
        this.cache.set(restaurantId, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
        return null;
      }
      if (!res.ok) throw new Error(`franchise-service replied ${res.status}`);
      const r = (await res.json()) as { isActive: boolean; seatingCapacity?: number; timeZone?: string };
      const value: RestaurantInfo = {
        isActive: r.isActive,
        seatingCapacity: r.seatingCapacity ?? DEFAULT_SEATING_CAPACITY,
        timeZone: r.timeZone || DEFAULT_TIME_ZONE,
      };
      this.cache.set(restaurantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (err) {
      this.logger.warn(`franchise-service unavailable, using defaults: ${(err as Error).message}`);
      return { isActive: true, seatingCapacity: DEFAULT_SEATING_CAPACITY, timeZone: DEFAULT_TIME_ZONE };
    }
  }
}
