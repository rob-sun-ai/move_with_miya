import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { ClassStatus } from './generated/prisma/client';
import {
  parseBoolean,
  parseDate,
  parseId,
  parseInteger,
  parseRequiredString,
  rejectUnknownFields,
} from './payload-validation';

/** The fields an admin may set when creating or updating a class. */
const CLASS_FIELDS = [
  'name',
  'teacherIds',
  'capacity',
  'cost',
  'description',
  'duration',
  'imageUrl',
  'startDate',
  'endDate',
  'locationId',
  'status',
  'isPrivate',
  'waitlistEnabled',
  'cancellationCutoffHours',
] as const;

interface ClassFields {
  name?: string;
  teacherIds?: string[];
  capacity?: number;
  cost?: number;
  description?: string;
  duration?: number;
  imageUrl?: string | null;
  startDate?: Date;
  endDate?: Date;
  locationId?: number;
  status?: ClassStatus;
  isPrivate?: boolean;
  waitlistEnabled?: boolean;
  cancellationCutoffHours?: number;
}

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}

  findClasses() {
    return this.prisma.client.yogaClass.findMany({
      include: { location: true },
    });
  }

  findClassesInRange(from: unknown, to: unknown) {
    return this.prisma.client.yogaClass.findMany({
      where: {
        startDate: { gte: parseDate(from, 'from') },
        endDate: { lte: parseDate(to, 'to') },
      },
      include: { location: true },
    });
  }

  findClass(id: unknown) {
    return this.prisma.client.yogaClass.findUnique({
      where: { id: parseId(id) },
      include: { location: true },
    });
  }

  private parseNonNegativeNumber(value: unknown, field: string): number {
    const raw =
      typeof value === 'number' || typeof value === 'string'
        ? String(value).trim()
        : '';
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
      throw new BadRequestException(`${field} must be a non-negative number`);
    }
    // The pattern above only admits finite, non-negative values.
    return Number(raw);
  }

  private parseTeacherIds(value: unknown): string[] {
    if (
      !Array.isArray(value) ||
      !value.every((id) => typeof id === 'string' && id.trim() !== '')
    ) {
      throw new BadRequestException('teacherIds must be an array of user ids');
    }
    return [...new Set(value as string[])];
  }

  private parseImageUrl(value: unknown): string | null {
    if (value === null || value === '') return null;
    let url: URL | undefined;
    try {
      url = typeof value === 'string' ? new URL(value) : undefined;
    } catch {
      url = undefined;
    }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      throw new BadRequestException('imageUrl must be an http(s) URL');
    }
    return value as string;
  }

  /** Validates every provided field; absent (undefined) fields stay absent. */
  private parseClassFields(data: Record<string, unknown>): ClassFields {
    rejectUnknownFields(data, CLASS_FIELDS);
    const fields: ClassFields = {};
    if (data.name !== undefined) {
      fields.name = parseRequiredString(data.name, 'name');
    }
    if (data.teacherIds !== undefined) {
      fields.teacherIds = this.parseTeacherIds(data.teacherIds);
    }
    if (data.capacity !== undefined) {
      fields.capacity = parseInteger(data.capacity, 'capacity', 1);
    }
    if (data.cost !== undefined) {
      fields.cost = this.parseNonNegativeNumber(data.cost, 'cost');
    }
    if (data.description !== undefined) {
      if (typeof data.description !== 'string') {
        throw new BadRequestException('description must be a string');
      }
      fields.description = data.description;
    }
    if (data.duration !== undefined) {
      fields.duration = parseInteger(data.duration, 'duration', 1);
    }
    if (data.imageUrl !== undefined) {
      fields.imageUrl = this.parseImageUrl(data.imageUrl);
    }
    if (data.startDate !== undefined) {
      fields.startDate = parseDate(data.startDate, 'startDate');
    }
    if (data.endDate !== undefined) {
      fields.endDate = parseDate(data.endDate, 'endDate');
    }
    if (data.locationId !== undefined) {
      fields.locationId = parseId(data.locationId, 'locationId');
    }
    if (data.status !== undefined) {
      if (!Object.values(ClassStatus).includes(data.status as ClassStatus)) {
        throw new BadRequestException('status is invalid');
      }
      fields.status = data.status as ClassStatus;
    }
    if (data.isPrivate !== undefined) {
      fields.isPrivate = parseBoolean(data.isPrivate, 'isPrivate');
    }
    if (data.waitlistEnabled !== undefined) {
      fields.waitlistEnabled = parseBoolean(
        data.waitlistEnabled,
        'waitlistEnabled',
      );
    }
    if (data.cancellationCutoffHours !== undefined) {
      fields.cancellationCutoffHours = parseInteger(
        data.cancellationCutoffHours,
        'cancellationCutoffHours',
        0,
      );
    }
    return fields;
  }

  createClass(data: Record<string, unknown>) {
    const fields = this.parseClassFields(data);
    const { name, capacity, startDate, endDate, locationId } = fields;
    if (name === undefined) throw new BadRequestException('name is required');
    if (capacity === undefined) {
      throw new BadRequestException('capacity is required');
    }
    if (startDate === undefined) {
      throw new BadRequestException('startDate is required');
    }
    if (endDate === undefined) {
      throw new BadRequestException('endDate is required');
    }
    if (locationId === undefined) {
      throw new BadRequestException('locationId is required');
    }
    if (endDate <= startDate) {
      throw new BadRequestException('endDate must be after startDate');
    }

    return this.prisma.client.yogaClass.create({
      data: {
        name,
        teacherIds: fields.teacherIds ?? [],
        capacity,
        cost: fields.cost ?? 0,
        description: fields.description ?? '',
        duration: fields.duration ?? 60,
        imageUrl: fields.imageUrl ?? null,
        startDate,
        endDate,
        locationId,
        status: fields.status ?? ClassStatus.Scheduled,
        isPrivate: fields.isPrivate ?? false,
        waitlistEnabled: fields.waitlistEnabled ?? true,
        cancellationCutoffHours: fields.cancellationCutoffHours ?? 24,
      },
      include: { location: true },
    });
  }

  updateClass(id: unknown, data: Record<string, unknown>) {
    const classId = parseId(id);
    const updateData = this.parseClassFields(data);
    const hasScheduleUpdate =
      updateData.startDate !== undefined || updateData.endDate !== undefined;
    if (!hasScheduleUpdate) {
      return this.prisma.client.yogaClass.update({
        where: { id: classId },
        data: updateData,
        include: { location: true },
      });
    }

    return this.prisma.client.$transaction(
      async (tx) => {
        const persistedClass = await tx.yogaClass.findUniqueOrThrow({
          where: { id: classId },
          select: { startDate: true, endDate: true },
        });
        const startDate = updateData.startDate ?? persistedClass.startDate;
        const endDate = updateData.endDate ?? persistedClass.endDate;

        if (endDate <= startDate) {
          throw new BadRequestException('endDate must be after startDate');
        }

        return tx.yogaClass.update({
          where: { id: classId },
          data: updateData,
          include: { location: true },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  deleteClass(id: unknown) {
    return this.prisma.client.yogaClass.delete({ where: { id: parseId(id) } });
  }
}
