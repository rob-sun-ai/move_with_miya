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

    it('rejects prices with more than two decimal places', () => {
      expect(() => service.createClass({ ...base, cost: '12.345' })).toThrow(
        BadRequestException,
      );
    });

    it('validates refund policy tiers', () => {
      expect(() =>
        service.createClass({
          ...base,
          refundPolicy: [{ hoursBeforeStart: 24, percentage: 101 }],
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects coerced or extra refund tier fields', () => {
      expect(() =>
        service.createClass({
          ...base,
          refundPolicy: [{ hoursBeforeStart: null, percentage: true } as never],
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        service.createClass({
          ...base,
          refundPolicy: [
            { hoursBeforeStart: 24, percentage: 100, note: 'unexpected' },
          ],
        }),
      ).toThrow(BadRequestException);
    });

    it.each([
      [[], 'refundPolicy must be a non-empty array'],
      [
        { hoursBeforeStart: 24, percentage: 100 },
        'refundPolicy must be a non-empty array',
      ],
      [[null], 'refundPolicy[0] is invalid'],
      [['24h'], 'refundPolicy[0] is invalid'],
      [
        [{ hoursBeforeStart: -1, percentage: 100 }],
        'refundPolicy[0].hoursBeforeStart must be a non-negative integer',
      ],
      [
        [{ hoursBeforeStart: 1.5, percentage: 100 }],
        'refundPolicy[0].hoursBeforeStart must be a non-negative integer',
      ],
      [
        [{ hoursBeforeStart: 24, percentage: -1 }],
        'refundPolicy[0].percentage must be an integer from 0 to 100',
      ],
      [
        [{ hoursBeforeStart: 24, percentage: 50.5 }],
        'refundPolicy[0].percentage must be an integer from 0 to 100',
      ],
      [
        [
          { hoursBeforeStart: 24, percentage: 100 },
          { hoursBeforeStart: 24, percentage: 50 },
        ],
        'refundPolicy thresholds must be unique',
      ],
      [
        [{ hoursBeforeStart: 48, percentage: 100 }],
        'refundPolicy must include a tier applicable at the cancellation cutoff',
      ],
    ])('rejects refund policy %j', (refundPolicy, message) => {
      expect(() => service.createClass({ ...base, refundPolicy })).toThrow(
        message,
      );
    });

    it('stores refund tiers ordered from the earliest cancellation', async () => {
      await service.createClass({
        ...base,
        cancellationCutoffHours: 12,
        refundPolicy: [
          { hoursBeforeStart: 12, percentage: 25 },
          { hoursBeforeStart: 72, percentage: 100 },
          { hoursBeforeStart: 24, percentage: 50 },
        ],
      });

      expect(prisma.yogaClass.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationCutoffHours: 12,
            refundPolicy: [
              { hoursBeforeStart: 72, percentage: 100 },
              { hoursBeforeStart: 24, percentage: 50 },
              { hoursBeforeStart: 12, percentage: 25 },
            ],
          }) as unknown,
        }),
      );
    });

    it('defaults to a full refund until 24 hours before start', async () => {
      await service.createClass(base);

      expect(prisma.yogaClass.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationCutoffHours: 24,
            refundPolicy: [{ hoursBeforeStart: 24, percentage: 100 }],
          }) as unknown,
        }),
      );
    });

    it('defaults to a full refund until the class cancellation cutoff', async () => {
      await service.createClass({ ...base, cancellationCutoffHours: 12 });

      expect(prisma.yogaClass.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancellationCutoffHours: 12,
            refundPolicy: [{ hoursBeforeStart: 12, percentage: 100 }],
          }) as unknown,
        }),
      );
    });

    it.each([
      ['name', { name: undefined }, 'name is required'],
      ['name', { name: '  ' }, 'name must be a non-empty string'],
      ['capacity', { capacity: undefined }, 'capacity is required'],
      ['capacity', { capacity: true }, 'capacity must be a positive integer'],
      [
        'capacity',
        { capacity: 3_000_000_000 },
        'capacity must be a positive integer',
      ],
      ['locationId', { locationId: undefined }, 'locationId is required'],
      [
        'locationId',
        { locationId: 'main' },
        'locationId must be a positive integer',
      ],
      [
        'teacherIds',
        { teacherIds: 'user-1' },
        'teacherIds must be an array of user ids',
      ],
      [
        'teacherIds',
        { teacherIds: [1] },
        'teacherIds must be an array of user ids',
      ],
      [
        'imageUrl',
        { imageUrl: 'javascript:alert(1)' },
        'imageUrl must be an http(s) URL',
      ],
      ['isPrivate', { isPrivate: 'yes' }, 'isPrivate must be a boolean'],
      ['description', { description: 5 }, 'description must be a string'],
      [
        'startDate',
        { startDate: '2026-09-01T10:00:00' },
        'startDate must be an ISO 8601 date-time with a timezone',
      ],
      ['cost', { cost: [5] }, 'cost must be a non-negative number'],
    ])('rejects an invalid %s', (_field, overrides, message) => {
      expect(() => service.createClass({ ...base, ...overrides })).toThrow(
        message,
      );
      expect(prisma.yogaClass.create).not.toHaveBeenCalled();
    });

    it('rejects fields that are not class settings', () => {
      expect(() =>
        service.createClass({ ...base, id: 7, createdAt: '2020-01-01' }),
      ).toThrow('Unknown fields: id, createdAt');
    });

    it('stores each teacher once and defaults to no teachers', async () => {
      await service.createClass({
        ...base,
        teacherIds: ['user-1', 'user-2', 'user-1'],
      });
      await service.createClass({ ...base, teacherIds: undefined });

      const calls = prisma.yogaClass.create.mock.calls as [
        { data: { teacherIds: string[] } },
      ][];
      expect(calls[0][0].data.teacherIds).toEqual(['user-1', 'user-2']);
      expect(calls[1][0].data.teacherIds).toEqual([]);
    });

    it('stores an empty image URL as no image', async () => {
      await service.createClass({ ...base, imageUrl: '' });

      expect(prisma.yogaClass.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ imageUrl: null }) as unknown,
        }),
      );
    });

    it.each(['0', '15', '15.5', '15.50', 20])('accepts price %p', (cost) => {
      expect(() => service.createClass({ ...base, cost })).not.toThrow();
    });

    it.each(['-1', '1e3', 'abc', '', '15.'])('rejects price %p', (cost) => {
      expect(() => service.createClass({ ...base, cost })).toThrow(
        'cost must be a non-negative number',
      );
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

    it.each([
      [{ location: { delete: true } }, 'Unknown fields: location'],
      [{ updatedAt: '2020-01-01T00:00:00Z' }, 'Unknown fields: updatedAt'],
      [{ name: null }, 'name must be a non-empty string'],
      [{ status: 'Archived' }, 'status is invalid'],
      [{ waitlistEnabled: 'false' }, 'waitlistEnabled must be a boolean'],
    ])('rejects the update %j', (data, message) => {
      expect(() => service.updateClass(1, data)).toThrow(message);
      expect(prisma.yogaClass.update).not.toHaveBeenCalled();
    });

    it('parses a price update to a number', async () => {
      prisma.yogaClass.update.mockResolvedValue({ id: 1 });
      await service.updateClass(1, { cost: '18.50' });
      expect(prisma.yogaClass.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { cost: 18.5 },
        include: { location: true },
      });
    });

    it('rejects a price update with sub-cent precision', () => {
      expect(() => service.updateClass(1, { cost: '18.505' })).toThrow(
        'cost must be a non-negative number',
      );
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

    it('validates a cutoff update against the persisted refund policy', async () => {
      prisma.yogaClass.findUniqueOrThrow.mockResolvedValue({
        startDate: new Date('2026-09-01T10:00:00.000Z'),
        endDate: new Date('2026-09-01T11:00:00.000Z'),
        cancellationCutoffHours: 48,
        refundPolicy: [
          { hoursBeforeStart: 72, percentage: 100 },
          { hoursBeforeStart: 48, percentage: 50 },
        ],
      });

      await expect(
        service.updateClass(1, { cancellationCutoffHours: 24 }),
      ).rejects.toThrow(
        'refundPolicy must include a tier applicable at the cancellation cutoff',
      );
      expect(prisma.yogaClass.update).not.toHaveBeenCalled();
    });

    it('moves the default refund policy along with a cutoff update', async () => {
      prisma.yogaClass.findUniqueOrThrow.mockResolvedValue({
        startDate: new Date('2026-09-01T10:00:00.000Z'),
        endDate: new Date('2026-09-01T11:00:00.000Z'),
        cancellationCutoffHours: 24,
        // Postgres jsonb returns keys in its own order.
        refundPolicy: [{ percentage: 100, hoursBeforeStart: 24 }],
      });
      prisma.yogaClass.update.mockResolvedValue({ id: 1 });

      await expect(
        service.updateClass(1, {
          name: 'Renamed',
          cancellationCutoffHours: 12,
        }),
      ).resolves.toEqual({ id: 1 });
      expect(prisma.yogaClass.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          name: 'Renamed',
          cancellationCutoffHours: 12,
          refundPolicy: [{ hoursBeforeStart: 12, percentage: 100 }],
        },
        include: { location: true },
      });
    });

    it('validates a refund policy update against the effective cutoff', async () => {
      prisma.yogaClass.findUniqueOrThrow.mockResolvedValue({
        startDate: new Date('2026-09-01T10:00:00.000Z'),
        endDate: new Date('2026-09-01T11:00:00.000Z'),
        cancellationCutoffHours: 24,
        refundPolicy: [{ hoursBeforeStart: 24, percentage: 100 }],
      });

      await expect(
        service.updateClass(1, {
          refundPolicy: [{ hoursBeforeStart: 48, percentage: 100 }],
        }),
      ).rejects.toThrow(
        'refundPolicy must include a tier applicable at the cancellation cutoff',
      );
      expect(prisma.yogaClass.update).not.toHaveBeenCalled();
    });

    it('accepts a refund policy and cutoff update when the pair is compatible', async () => {
      prisma.yogaClass.findUniqueOrThrow.mockResolvedValue({
        startDate: new Date('2026-09-01T10:00:00.000Z'),
        endDate: new Date('2026-09-01T11:00:00.000Z'),
        cancellationCutoffHours: 24,
        refundPolicy: [{ hoursBeforeStart: 24, percentage: 100 }],
      });
      prisma.yogaClass.update.mockResolvedValue({ id: 1 });

      await expect(
        service.updateClass(1, {
          cancellationCutoffHours: 12,
          refundPolicy: [
            { hoursBeforeStart: 12, percentage: 50 },
            { hoursBeforeStart: 48, percentage: 100 },
          ],
        }),
      ).resolves.toEqual({ id: 1 });
      expect(prisma.yogaClass.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          cancellationCutoffHours: 12,
          refundPolicy: [
            { hoursBeforeStart: 48, percentage: 100 },
            { hoursBeforeStart: 12, percentage: 50 },
          ],
        },
        include: { location: true },
      });
    });
  });
});
