import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export enum ReservationStatus {
  Pending = 'PENDING',
  Confirmed = 'CONFIRMED',
  Seated = 'SEATED',
  Cancelled = 'CANCELLED',
  NoShow = 'NO_SHOW',
}

@Schema({ collection: 'reservations', timestamps: true })
export class Reservation {
  /** Owning restaurant (tenant) — the isolation boundary. */
  @Prop({ required: true, index: true })
  restaurantId: string;

  @Prop({ required: true, index: true })
  customerId: string;

  @Prop({ required: true })
  customerName: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ required: true, min: 1, max: 20 })
  partySize: number;

  /** When the guests are expected. */
  @Prop({ required: true, type: Date, index: true })
  reservationAt: Date;

  @Prop({ required: true, enum: ReservationStatus, default: ReservationStatus.Pending, index: true })
  status: ReservationStatus;

  @Prop({ default: '' })
  notes: string;
}

export type ReservationDocument = HydratedDocument<Reservation>;
export const ReservationSchema = SchemaFactory.createForClass(Reservation);
