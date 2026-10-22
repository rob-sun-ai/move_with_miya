import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  parseId,
  parseRequiredString,
  rejectUnknownFields,
} from '../payload-validation';

const REQUIRED_FIELDS = ['address', 'city', 'state', 'zipCode'] as const;

interface LocationFields {
  name?: string | null;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

@Injectable()
export class LocationService {
  constructor(private readonly prisma: PrismaService) {}

  findLocations() {
    return this.prisma.client.location.findMany();
  }

  async findLocation(id: unknown) {
    const locationId = parseId(id);
    const location = await this.prisma.client.location.findUnique({
      where: { id: locationId },
    });
    if (!location) {
      throw new NotFoundException(`Location ${locationId} not found`);
    }
    return location;
  }

  /** Validates every provided field; absent (undefined) fields stay absent. */
  private parseLocationFields(data: Record<string, unknown>): LocationFields {
    rejectUnknownFields(data, ['name', ...REQUIRED_FIELDS]);
    const fields: LocationFields = {};
    if (data.name !== undefined) {
      if (data.name !== null && typeof data.name !== 'string') {
        throw new BadRequestException('name must be a string');
      }
      fields.name = data.name || null;
    }
    for (const field of REQUIRED_FIELDS) {
      if (data[field] !== undefined) {
        fields[field] = parseRequiredString(data[field], field);
      }
    }
    return fields;
  }

  createLocation(data: Record<string, unknown>) {
    const fields = this.parseLocationFields(data);
    const { address, city, state, zipCode } = fields;
    if (!address || !city || !state || !zipCode) {
      throw new BadRequestException(
        'address, city, state, and zipCode are required',
      );
    }
    return this.prisma.client.location.create({
      data: { name: fields.name ?? null, address, city, state, zipCode },
    });
  }

  updateLocation(id: unknown, data: Record<string, unknown>) {
    return this.prisma.client.location.update({
      where: { id: parseId(id) },
      data: this.parseLocationFields(data),
    });
  }

  deleteLocation(id: unknown) {
    return this.prisma.client.location.delete({ where: { id: parseId(id) } });
  }
}
