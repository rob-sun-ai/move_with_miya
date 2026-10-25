import { Controller, UseFilters } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { LocationService } from './location.service';
import { asPayload } from '../payload-validation';
import { RpcErrorFilter } from '../rpc-exception.filter';

@Controller()
@UseFilters(new RpcErrorFilter())
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  @MessagePattern({ cmd: 'get_locations' })
  findLocations() {
    return this.locationService.findLocations();
  }

  @MessagePattern({ cmd: 'get_location' })
  findLocation(data: unknown) {
    return this.locationService.findLocation(asPayload(data).id);
  }

  @MessagePattern({ cmd: 'create_location' })
  createLocation(data: unknown) {
    return this.locationService.createLocation(asPayload(data));
  }

  @MessagePattern({ cmd: 'update_location' })
  updateLocation(data: unknown) {
    const { id, ...rest } = asPayload(data);
    return this.locationService.updateLocation(id, rest);
  }

  @MessagePattern({ cmd: 'delete_location' })
  deleteLocation(data: unknown) {
    return this.locationService.deleteLocation(asPayload(data).id);
  }
}
