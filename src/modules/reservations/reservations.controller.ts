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
import { ReservationsService, toPage } from './reservations.service';

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
  @ApiOperation({ summary: "The customer's own reservations (limit/offset)" })
  listMine(@CurrentActor() actor: Actor, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.reservations.listMine(actor, toPage(Number(limit), Number(offset)));
  }

  @Get('restaurant')
  @Roles('manager', 'admin')
  @ApiOperation({ summary: "A restaurant's reservations: the manager's own, any for head office (?restaurantId)" })
  listForRestaurant(
    @CurrentActor() actor: Actor,
    @Query('status') status?: ReservationStatus,
    @Query('restaurantId') restaurantId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.reservations.listForRestaurant(actor, restaurantId, status, toPage(Number(limit), Number(offset)));
  }

  @Get('availability')
  @ApiOperation({ summary: 'Remaining covers of every slot of a day (restaurant local time)' })
  getAvailability(@Query('restaurantId') restaurantId: string, @Query('date') date: string) {
    return this.reservations.getAvailability(restaurantId, date);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Reservation detail' })
  getById(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.reservations.getById(actor, id);
  }

  @Patch(':id/status')
  @Roles('manager', 'admin')
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
