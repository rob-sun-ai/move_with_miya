import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { LocationService } from './location.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LocationService', () => {
  let service: LocationService;
  let location: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    location = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        LocationService,
        { provide: PrismaService, useValue: { client: { location } } },
      ],
    }).compile();
    service = module.get(LocationService);
  });

  it('lists locations', async () => {
    location.findMany.mockResolvedValue([{ id: 1 }]);
    await expect(service.findLocations()).resolves.toEqual([{ id: 1 }]);
    expect(location.findMany).toHaveBeenCalledWith();
  });

  it('returns a location by id', async () => {
    location.findUnique.mockResolvedValue({ id: 2, city: 'Boston' });
    await expect(service.findLocation(2)).resolves.toEqual({
      id: 2,
      city: 'Boston',
    });
    expect(location.findUnique).toHaveBeenCalledWith({ where: { id: 2 } });
  });

  it('throws when a location does not exist', async () => {
    location.findUnique.mockResolvedValue(null);
    await expect(service.findLocation(99)).rejects.toThrow(NotFoundException);
  });

  it('creates, updates, and deletes locations', async () => {
    const data = {
      name: 'Studio',
      address: '1 Main St',
      city: 'Boston',
      state: 'MA',
      zipCode: '02110',
    };
    location.create.mockResolvedValue({ id: 1, ...data });
    location.update.mockResolvedValue({ id: 1, ...data });
    location.delete.mockResolvedValue({ id: 1 });

    await expect(service.createLocation(data)).resolves.toMatchObject({
      id: 1,
    });
    await expect(
      service.updateLocation(1, { city: 'Cambridge' }),
    ).resolves.toMatchObject({ id: 1 });
    await expect(service.deleteLocation(1)).resolves.toEqual({ id: 1 });
    expect(location.create).toHaveBeenCalledWith({ data });
    expect(location.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { city: 'Cambridge' },
    });
    expect(location.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('stores a blank name as no name', async () => {
    await service.createLocation({
      name: '',
      address: '1 Main St',
      city: 'Boston',
      state: 'MA',
      zipCode: '02110',
    });
    expect(location.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: null }) as unknown,
    });
  });

  it.each([
    [{ address: '1 Main St', city: 'Boston', state: 'MA' }, 'are required'],
    [
      { address: '', city: 'Boston', state: 'MA', zipCode: '02110' },
      'address must be a non-empty string',
    ],
    [
      { address: 1, city: 'Boston', state: 'MA', zipCode: '02110' },
      'address must be a non-empty string',
    ],
  ])('rejects the new location %j', (data, message) => {
    expect(() => service.createLocation(data)).toThrow(message);
    expect(location.create).not.toHaveBeenCalled();
  });

  it('rejects nested writes and other unknown fields on update', () => {
    expect(() =>
      service.updateLocation(1, { classes: { deleteMany: {} } }),
    ).toThrow('Unknown fields: classes');
    expect(() => service.updateLocation(1, { city: null })).toThrow(
      'city must be a non-empty string',
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid location id', async () => {
    await expect(service.findLocation('two')).rejects.toThrow(
      BadRequestException,
    );
    expect(() => service.deleteLocation(undefined)).toThrow(
      BadRequestException,
    );
    expect(location.findUnique).not.toHaveBeenCalled();
    expect(location.delete).not.toHaveBeenCalled();
  });
});
