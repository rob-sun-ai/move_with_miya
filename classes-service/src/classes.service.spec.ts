import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ClassesService } from './classes.service';

jest.mock('./prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => ({ client: {} })),
}));
jest.mock('./generated/prisma/client', () => ({
  ClassStatus: { Scheduled: 'Scheduled' },
}));
import { PrismaService } from './prisma/prisma.service';

describe('ClassesService date validation', () => {
  let service: ClassesService;
  let prisma: {
    yogaClass: {
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      yogaClass: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        ClassesService,
        { provide: PrismaService, useValue: { client: prisma } },
      ],
    }).compile();

    service = module.get(ClassesService);
  });

  describe('createClass', () => {
    const base = {
      name: 'Vinyasa',
      teacherIds: ['user-1'],
      capacity: 10,
      startDate: '2026-09-01T10:00:00.000Z',
      endDate: '2026-09-01T11:00:00.000Z',
      locationId: 1,
    };

    it('creates a class with valid dates', async () => {
      prisma.yogaClass.create.mockResolvedValue({ id: 1 });
      const result = await service.createClass(base);
      expect(result).toEqual({ id: 1 });
      expect(prisma.yogaClass.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate: expect.any(Date) as never,
            endDate: expect.any(Date) as never,
          }) as never,
        }) as never,
      );
    });

    it('persists all class fields including privacy', async () => {
      prisma.yogaClass.create.mockResolvedValue({ id: 1 });

      await service.createClass({
        ...base,
        cost: '25.50',
        description: 'A restorative session',
        duration: 75,
        imageUrl: 'https://example.com/yoga.jpg',
        isPrivate: true,
      });

      expect(prisma.yogaClass.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cost: 25.5,
            description: 'A restorative session',
            duration: 75,
            imageUrl: 'https://example.com/yoga.jpg',
            isPrivate: true,
            waitlistEnabled: true,
            cancellationCutoffHours: 24,
          }) as never,
        }) as never,
      );
    });

    it('rejects a missing startDate', () => {
      expect(() => service.createClass({ ...base, startDate: '' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects an invalid startDate', () => {
      expect(() =>
        service.createClass({ ...base, startDate: 'not-a-date' }),
      ).toThrow(BadRequestException);
    });

    it('rejects an end date that is not after the start date', () => {
      expect(() =>
        service.createClass({
          ...base,
          endDate: base.startDate,
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects an invalid cancellation cutoff', () => {
      expect(() =>
        service.createClass({ ...base, cancellationCutoffHours: -1 }),
      ).toThrow(BadRequestException);
    });
  });

  it('loads classes with their locations', async () => {
    prisma.yogaClass.findMany.mockResolvedValue([{ id: 1 }]);

    await expect(service.findClasses()).resolves.toEqual([{ id: 1 }]);
    expect(prisma.yogaClass.findMany).toHaveBeenCalledWith({
      include: { location: true },
    });
  });

  it('loads classes in a date range', async () => {
    prisma.yogaClass.findMany.mockResolvedValue([]);

    await service.findClassesInRange(
      '2026-09-01T00:00:00.000Z',
      '2026-09-30T23:59:59.000Z',
    );

    expect(prisma.yogaClass.findMany).toHaveBeenCalledWith({
      where: {
        startDate: { gte: new Date('2026-09-01T00:00:00.000Z') },
        endDate: { lte: new Date('2026-09-30T23:59:59.000Z') },
      },
      include: { location: true },
    });
  });

  it.each([
    ['from', undefined, '2026-09-30T23:59:59.000Z', 'from is required'],
    [
      'to',
      '2026-09-01T00:00:00.000Z',
      'next week',
      'to must be an ISO 8601 date-time with a timezone',
    ],
  ])('rejects a range with an invalid %s', (_field, from, to, message) => {
    expect(() => service.findClassesInRange(from, to)).toThrow(message);
    expect(prisma.yogaClass.findMany).not.toHaveBeenCalled();
  });

  it.each([undefined, '1; DROP', 0, 1.5])('rejects the class id %p', (id) => {
    expect(() => service.findClass(id)).toThrow(BadRequestException);
    expect(() => service.deleteClass(id)).toThrow(BadRequestException);
    expect(() => service.updateClass(id, { name: 'x' })).toThrow(
      BadRequestException,
    );
  });

  it('loads and deletes a class by id', async () => {
    prisma.yogaClass.findUnique.mockResolvedValue({ id: 1 });
    prisma.yogaClass.delete.mockResolvedValue({ id: 1 });

    await expect(service.findClass(1)).resolves.toEqual({ id: 1 });
    await expect(service.deleteClass(1)).resolves.toEqual({ id: 1 });
    expect(prisma.yogaClass.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { location: true },
    });
    expect(prisma.yogaClass.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  describe('updateClass', () => {
    it('passes through updates without date fields untouched', async () => {
      prisma.yogaClass.update.mockResolvedValue({ id: 1 });
      await service.updateClass(1, { name: 'Updated' });
      expect(prisma.yogaClass.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { name: 'Updated' },
        include: { location: true },
      });
    });

    it('converts a valid startDate to a Date', async () => {
      prisma.yogaClass.findUniqueOrThrow.mockResolvedValue({
        startDate: new Date('2026-09-01T09:00:00.000Z'),
        endDate: new Date('2026-09-01T11:00:00.000Z'),
      });
      prisma.yogaClass.update.mockResolvedValue({ id: 1 });
      await service.updateClass(1, { startDate: '2026-09-01T10:00:00.000Z' });
      expect(prisma.yogaClass.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startDate: expect.any(Date) as never,
          }) as never,
        }) as never,
      );
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function) as never,
        { isolationLevel: 'Serializable' },
      );
    });

    it('validates an endDate against the persisted startDate', async () => {
      prisma.yogaClass.findUniqueOrThrow.mockResolvedValue({
        startDate: new Date('2026-09-01T10:00:00.000Z'),
        endDate: new Date('2026-09-01T11:00:00.000Z'),
      });

      await expect(
        service.updateClass(1, { endDate: '2026-09-01T09:00:00.000Z' }),
      ).rejects.toThrow('endDate must be after startDate');
      expect(prisma.yogaClass.update).not.toHaveBeenCalled();
    });

    it('rejects an invalid startDate', () => {
      expect(() => service.updateClass(1, { startDate: 'nope' })).toThrow(
        BadRequestException,
      );
    });
  });
});
