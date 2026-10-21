import { Test } from '@nestjs/testing';
import { NEVER, of, throwError } from 'rxjs';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { RegistrationController } from './RegistrationController';
import { UpdateRegistrationDto } from './dto/update-registration.dto';

jest.mock('../common/guards/admin.guard', () => ({
  AdminGuard: jest.fn().mockImplementation(() => ({ canActivate: () => true })),
}));
jest.mock('../common/guards/staff.guard', () => ({
  StaffGuard: jest.fn().mockImplementation(() => ({ canActivate: () => true })),
}));

describe('RegistrationController', () => {
  let controller: RegistrationController;
  let client: { send: jest.Mock };
  let classesClient: { send: jest.Mock };

  const sessionUserId = 'user-1';

  const buildRequest = (userId?: string) =>
    ({ session: { userId: userId ?? null } }) as Parameters<
      RegistrationController['createRegistration']
    >[0];

  beforeEach(async () => {
    client = { send: jest.fn() };
    classesClient = { send: jest.fn() };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ banned: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const module = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [
        { provide: 'REGISTRATION_SERVICE', useValue: client },
        { provide: 'CLASSES_SERVICE', useValue: classesClient },
      ],
    }).compile();
    controller = module.get(RegistrationController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('rpc error mapping', () => {
    it('maps 409 to ConflictException', async () => {
      client.send.mockReturnValue(
        throwError(() => ({ statusCode: 409, message: 'Already registered' })),
      );
      await expect(
        controller['rpc']('create_registration', { classId: 1, userId: 'u' }),
      ).rejects.toThrow(ConflictException);
    });

    it('maps 404 to NotFoundException', async () => {
      client.send.mockReturnValue(
        throwError(() => ({ statusCode: 404, message: 'Not registered' })),
      );
      await expect(
        controller['rpc']('get_registration_by_class_and_user', {
          classId: 1,
          userId: 'u',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('maps 400 to BadRequestException', async () => {
      client.send.mockReturnValue(
        throwError(() => ({ statusCode: 400, message: 'Bad input' })),
      );
      await expect(
        controller['rpc']('update_registration', { id: 1 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('maps unknown errors to ServiceUnavailableException without their details', async () => {
      client.send.mockReturnValue(throwError(() => ({ message: 'boom' })));
      await expect(
        controller['rpc']('update_registration', { id: 1 }),
      ).rejects.toEqual(
        new ServiceUnavailableException('Registration service unavailable'),
      );
    });

    it('gives up on a registration service that never replies', async () => {
      jest.useFakeTimers();
      try {
        client.send.mockReturnValue(NEVER);
        const result = controller['rpc']('get_registration', { id: 1 });
        const assertion = expect(result).rejects.toEqual(
          new ServiceUnavailableException('Registration service unavailable'),
        );
        await jest.advanceTimersByTimeAsync(10_000);
        await assertion;
      } finally {
        jest.useRealTimers();
      }
    });

    it('propagates successful values', async () => {
      client.send.mockReturnValue(of({ id: 5 }));
      await expect(
        controller['rpc']('get_registration', { id: 5 }),
      ).resolves.toEqual({ id: 5 });
    });
  });

  describe('auth checks', () => {
    it('rejects unauthenticated createRegistration', async () => {
      await expect(
        controller.createRegistration(buildRequest(), 1, 'user-1'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('forbids registering another user', async () => {
      await expect(
        controller.createRegistration(buildRequest(sessionUserId), 1, 'user-2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows self-registration for an open class', async () => {
      classesClient.send.mockReturnValue(
        of({ id: 1, capacity: 10, endDate: '2099-01-01T00:00:00.000Z' }),
      );
      client.send.mockReturnValue(of({ id: 1 }));
      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).resolves.toEqual({ id: 1 });
      expect(client.send).toHaveBeenCalledWith(
        { cmd: 'create_registration' },
        {
          classId: 1,
          userId: sessionUserId,
          capacity: 10,
          waitlistEnabled: true,
        },
      );
    });

    it('rejects direct registration for paid classes', async () => {
      classesClient.send.mockReturnValue(
        of({
          id: 1,
          capacity: 10,
          cost: '15.00',
          endDate: '2099-01-01T00:00:00.000Z',
        }),
      );

      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).rejects.toMatchObject({
        message: 'Paid classes require Stripe Checkout',
      });
      expect(client.send).not.toHaveBeenCalled();
    });

    it.each(['free', '-5', 'NaN'])(
      'rejects direct registration for a class priced %p',
      async (cost) => {
        classesClient.send.mockReturnValue(
          of({
            id: 1,
            capacity: 10,
            cost,
            endDate: '2099-01-01T00:00:00.000Z',
          }),
        );

        await expect(
          controller.createRegistration(
            buildRequest(sessionUserId),
            1,
            sessionUserId,
          ),
        ).rejects.toMatchObject({ message: 'Class price is invalid' });
        expect(client.send).not.toHaveBeenCalled();
      },
    );

    it('forbids registration for an ended class', async () => {
      classesClient.send.mockReturnValue(
        of({ id: 1, endDate: '2000-01-01T00:00:00.000Z' }),
      );
      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('requires yoga experience for a private class', async () => {
      classesClient.send.mockReturnValue(
        of({
          id: 1,
          capacity: 10,
          isPrivate: true,
          endDate: '2099-01-01T00:00:00.000Z',
        }),
      );

      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).rejects.toMatchObject({
        message: 'Yoga experience is required for this class',
      });
      expect(client.send).not.toHaveBeenCalled();
    });

    it('allows a private-class registration when experience exists', async () => {
      classesClient.send.mockReturnValue(
        of({
          id: 1,
          capacity: 10,
          isPrivate: true,
          endDate: '2099-01-01T00:00:00.000Z',
        }),
      );
      (global.fetch as jest.Mock).mockResolvedValue(
        new Response(JSON.stringify({ yogaExperience: 'Five years of yoga' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      client.send.mockReturnValue(of({ id: 1 }));

      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).resolves.toEqual({ id: 1 });
    });

    it('rejects banned users', async () => {
      classesClient.send.mockReturnValue(
        of({ id: 1, capacity: 10, endDate: '2099-01-01T00:00:00.000Z' }),
      );
      (global.fetch as jest.Mock).mockResolvedValue(
        new Response(JSON.stringify({ banned: true }), { status: 200 }),
      );

      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).rejects.toMatchObject({ message: 'User is banned' });
    });

    it('rejects canceled classes', async () => {
      classesClient.send.mockReturnValue(
        of({
          id: 1,
          capacity: 10,
          status: 'Canceled',
          endDate: '2099-01-01T00:00:00.000Z',
        }),
      );

      await expect(
        controller.createRegistration(
          buildRequest(sessionUserId),
          1,
          sessionUserId,
        ),
      ).rejects.toMatchObject({
        message: 'This class is not open for registration',
      });
    });
  });

  describe('admin registration listing', () => {
    it('returns all registrations enriched with users and class details', async () => {
      const registration = {
        id: 9,
        classId: 3,
        userId: 'user-1',
        status: 'Registered',
        registeredAt: '2026-09-01T10:00:00.000Z',
      };
      client.send.mockReturnValue(of([registration]));
      classesClient.send.mockReturnValue(
        of([
          {
            id: 3,
            name: 'Morning Flow',
            startDate: '2026-09-05T10:00:00.000Z',
            endDate: '2026-09-05T11:00:00.000Z',
          },
        ]),
      );
      (global.fetch as jest.Mock).mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: 'user-1',
              firstName: 'Miya',
              lastName: 'Sun',
              role: 'MEMBER',
            },
          ]),
          { status: 200 },
        ),
      );

      await expect(controller.findAllRegistrations()).resolves.toEqual([
        {
          ...registration,
          user: {
            id: 'user-1',
            firstName: 'Miya',
            lastName: 'Sun',
            role: 'MEMBER',
          },
          class: {
            id: 3,
            name: 'Morning Flow',
            startDate: '2026-09-05T10:00:00.000Z',
            endDate: '2026-09-05T11:00:00.000Z',
          },
        },
      ]);
      expect(client.send).toHaveBeenCalledWith(
        { cmd: 'get_all_registrations' },
        {},
      );
    });
  });

  describe('member registration listing', () => {
    it('attaches class details but no user profiles', async () => {
      const registration = {
        id: 9,
        classId: 3,
        userId: sessionUserId,
        status: 'Registered',
        registeredAt: '2026-09-01T10:00:00.000Z',
      };
      const cls = {
        id: 3,
        name: 'Morning Flow',
        startDate: '2026-09-05T10:00:00.000Z',
        endDate: '2026-09-05T11:00:00.000Z',
      };
      client.send.mockReturnValue(
        of([registration, { ...registration, id: 10, classId: 99 }]),
      );
      classesClient.send.mockReturnValue(of([cls]));

      await expect(
        controller.getMyRegistrations(buildRequest(sessionUserId)),
      ).resolves.toEqual([
        { ...registration, class: cls },
        { ...registration, id: 10, classId: 99, class: null },
      ]);
      expect(client.send).toHaveBeenCalledWith(
        { cmd: 'get_registrations_by_user' },
        { userId: sessionUserId },
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('still lists registrations when the class service is down', async () => {
      const registration = { id: 9, classId: 3, userId: sessionUserId };
      client.send.mockReturnValue(of([registration]));
      classesClient.send.mockReturnValue(throwError(() => new Error('down')));

      await expect(
        controller.getMyRegistrations(buildRequest(sessionUserId)),
      ).resolves.toEqual([{ ...registration, class: null }]);
    });
  });

  describe('admin registration updates', () => {
    it('always updates the registration named in the route', async () => {
      client.send.mockReturnValue(of({ id: 5 }));

      await controller.updateRegistration(5, {
        id: 7,
        cancellationReason: 'Moved',
      } as never);

      expect(client.send).toHaveBeenCalledWith(
        { cmd: 'update_registration' },
        { id: 5, cancellationReason: 'Moved' },
      );
    });

    it('accepts only the editable fields', async () => {
      const pipe = new ValidationPipe({ whitelist: true, transform: true });
      const metadata = {
        type: 'body' as const,
        metatype: UpdateRegistrationDto,
      };

      await expect(
        pipe.transform(
          { cancellationReason: 'Moved', classId: 4, userId: 'other' },
          metadata,
        ),
      ).resolves.toEqual({ cancellationReason: 'Moved' });
      await expect(
        pipe.transform({ cancellationReason: 4 }, metadata),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
