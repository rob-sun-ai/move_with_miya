jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../generated/prisma/client', () => ({
  UserRole: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', TEACHER: 'TEACHER' },
}));

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { UsersController } from './users.controller';

describe('UsersController', () => {
  let controller: UsersController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = {
      create: jest.fn(),
      findAll: jest.fn(),
      findByIds: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      updateRole: jest.fn(),
      toggleBan: jest.fn(),
      remove: jest.fn(),
    };
    controller = new UsersController(service as never);
  });

  it('delegates user lookup', async () => {
    service.findAll.mockResolvedValue(['all']);
    service.findById.mockResolvedValue({ id: 'user-1' });
    await expect(controller.findAll()).resolves.toEqual(['all']);
    await expect(controller.findById('user-1')).resolves.toEqual({
      id: 'user-1',
    });
    expect(service.findById).toHaveBeenCalledWith('user-1');
  });

  it('does not expose a user creation endpoint', () => {
    const prototype = UsersController.prototype as unknown as Record<
      string,
      unknown
    >;
    const methods = Object.getOwnPropertyNames(prototype).map((name): unknown =>
      Reflect.getMetadata(METHOD_METADATA, prototype[name] as object),
    );
    expect(methods).toContain(RequestMethod.PATCH);
    expect(methods).not.toContain(RequestMethod.POST);
  });

  it('normalizes and limits batch user responses', async () => {
    service.findByIds.mockResolvedValue([
      {
        id: 'user-1',
        firstName: 'A',
        lastName: 'Person',
        avatarUrl: null,
        role: 'TEACHER',
        email: 'private@example.com',
      },
    ]);
    await expect(controller.findByIds('user-1, user-2,,')).resolves.toEqual([
      {
        id: 'user-1',
        firstName: 'A',
        lastName: 'Person',
        avatarUrl: null,
        role: 'TEACHER',
      },
    ]);
    expect(service.findByIds).toHaveBeenCalledWith(['user-1', 'user-2']);
  });

  it('answers a batch request without ids instead of failing', async () => {
    service.findByIds.mockResolvedValue([]);
    await expect(controller.findByIds(undefined)).resolves.toEqual([]);
    expect(service.findByIds).toHaveBeenCalledWith([]);
  });

  it('looks up each batch id once', async () => {
    service.findByIds.mockResolvedValue([]);
    await controller.findByIds('user-1,user-1, user-1');
    expect(service.findByIds).toHaveBeenCalledWith(['user-1']);
  });

  it('delegates profile and admin mutations', async () => {
    service.update.mockResolvedValue('updated');
    service.updateRole.mockResolvedValue('role');
    service.toggleBan.mockResolvedValue('ban');
    service.remove.mockResolvedValue('removed');
    await expect(
      controller.update('user-1', { firstName: 'New' }),
    ).resolves.toBe('updated');
    await expect(controller.updateRole('user-1', 'ADMIN')).resolves.toBe(
      'role',
    );
    await expect(controller.toggleBan('user-1')).resolves.toBe('ban');
    await expect(controller.remove('user-1')).resolves.toBe('removed');
    expect(service.update).toHaveBeenCalledWith('user-1', { firstName: 'New' });
    expect(service.updateRole).toHaveBeenCalledWith('user-1', 'ADMIN');
    expect(service.toggleBan).toHaveBeenCalledWith('user-1');
    expect(service.remove).toHaveBeenCalledWith('user-1');
  });
});
