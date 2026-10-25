import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => ({ client: {} })),
}));
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const user = {
    id: 'user-1',
    googleId: 'google-1',
    email: 'person@example.com',
    firstName: 'Move',
    lastName: 'Miya',
    role: 'MEMBER',
    banned: false,
    yogaExperience: null,
  };

  beforeEach(async () => {
    prisma = {
      user: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: { client: prisma } },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('creates a user', async () => {
    prisma.user.create.mockResolvedValue(user);

    await expect(
      service.create({
        googleId: 'google-1',
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      }),
    ).resolves.toEqual(user);
  });

  it('finds a user and throws when absent', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(user);
    await expect(service.findById('user-1')).resolves.toEqual(user);

    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.findById('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('finds users by ids and avoids an empty query', async () => {
    await expect(service.findByIds([])).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();

    prisma.user.findMany.mockResolvedValue([user]);
    await expect(service.findByIds(['user-1'])).resolves.toEqual([user]);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-1'] } },
    });
  });

  it('updates a user after verifying it exists', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({
      ...user,
      yogaExperience: 'Beginner',
    });

    await expect(
      service.update('user-1', { yogaExperience: 'Beginner' }),
    ).resolves.toMatchObject({ yogaExperience: 'Beginner' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { yogaExperience: 'Beginner' },
    });
  });

  it('updates roles only through the role operation', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, role: 'TEACHER' });

    await expect(
      service.updateRole('user-1', 'TEACHER'),
    ).resolves.toMatchObject({
      role: 'TEACHER',
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'TEACHER' },
    });
  });

  it('toggles the ban state transactionally', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, banned: true });

    await expect(service.toggleBan('user-1')).resolves.toMatchObject({
      banned: true,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { banned: true },
    });
  });

  it('does not toggle a missing user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.toggleBan('missing')).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('links a Google subject and records the login', async () => {
    prisma.user.update.mockResolvedValue(user);

    await service.linkGoogleAccount('user-1', 'google-2');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { googleId: 'google-2', lastLoginAt: expect.any(Date) as Date },
    });
  });

  it('deletes an existing user', async () => {
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.user.delete.mockResolvedValue(user);

    await expect(service.remove('user-1')).resolves.toBeUndefined();
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-1' },
    });
  });
});
