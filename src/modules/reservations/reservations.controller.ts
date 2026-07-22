import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor } from '../../common/auth.util';
import { CurrentActor } from '../../common/decorators/current-actor.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { ReservationStatus } from './entities/reservation.schema';
import { ReservationsService } from './reservations.service';

/** Thin HTTP layer: validates DTOs and delegates — no business logic. */
@ApiTags('reservations')
@ApiBearerAuth()
@Controller('api/reservations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @Roles('user')
  @ApiOperation({ summary: 'Book a table at a restaurant' })
  create(@CurrentActor() actor: Actor, @Body() dto: CreateReservationDto) {
    return this.reservations.create(actor, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "The customer's own reservations" })
  listMine(@CurrentActor() actor: Actor) {
    return this.reservations.listMine(actor);
  }

  @Get('restaurant')
  @Roles('manager')
  @ApiOperation({ summary: "Reservations of the manager's own restaurant" })
  listForMyRestaurant(@CurrentActor() actor: Actor, @Query('status') status?: ReservationStatus) {
    return this.reservations.listForMyRestaurant(actor, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Reservation detail' })
  getById(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.reservations.getById(actor, id);
  }

  @Patch(':id/status')
  @Roles('manager')
  @ApiOperation({ summary: 'Confirm / seat / cancel a reservation (restaurant side)' })
  updateStatus(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.reservations.updateStatus(actor, id, dto.status);
  }

  @Patch(':id/cancel')
  @Roles('user')
  @ApiOperation({ summary: 'Customer cancels their own reservation' })
  cancelMine(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.reservations.cancelMine(actor, id);
  }
}
