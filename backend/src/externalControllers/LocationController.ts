import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AdminGuard } from '../common/guards/admin.guard';
import { sendRpc } from '../common/rpc';

@Controller('locations')
export class LocationController {
  constructor(
    @Inject('CLASSES_SERVICE') private readonly classesClient: ClientProxy,
  ) {}

  private rpc(cmd: string, payload: object) {
    return sendRpc(
      this.classesClient,
      cmd,
      payload,
      'Class service unavailable',
    );
  }

  @Get()
  findLocations() {
    return this.rpc('get_locations', {});
  }

  @Get(':id')
  findLocation(@Param('id', ParseIntPipe) id: number) {
    return this.rpc('get_location', { id });
  }

  @UseGuards(AdminGuard)
  @Post()
  createLocation(@Body() body: Record<string, unknown>) {
    return this.rpc('create_location', body);
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  updateLocation(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    return this.rpc('update_location', { ...body, id });
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  deleteLocation(@Param('id', ParseIntPipe) id: number) {
    return this.rpc('delete_location', { id });
  }
}
