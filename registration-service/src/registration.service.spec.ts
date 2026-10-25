import { Test } from '@nestjs/testing';
import { RpcException } from '@nestjs/microservices';
import { RegistrationService } from './registration.service';

jest.mock('./prisma/prisma.service', () => ({
  PrismaService: jest.fn().mockImplementation(() => ({ client: {} })),
}));
import { PrismaService } from './prisma/prisma.service';

describe('RegistrationService', () => {
  let service: RegistrationService;
  let prisma: {
    registration: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
      groupBy: jest.Mock;
      count: jest.Mock;
    };
    contactSubmission: {
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
    outboxEvent: {
      create: jest.Mock;
    };
    notificationDelivery: {
      updateMany: jest.Mock;
      create: jest.Mock;
    };
  };

  const existing = {
    id: 1,
    classId: 10,
    userId: 'user-1',
    status: 'Registered',
  };

  beforeEach(async () => {
    prisma = {
      registration: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
        groupBy: jest.fn(),
        count: jest.fn(),
      },
      contactSubmission: {
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
      notificationDelivery: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: typeof prisma) => unknown) =>
        callback(prisma),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: PrismaService, useValue: { client: prisma } },
      ],
    }).compile();

    service = module.get(RegistrationService);
  });

  it('returns counts grouped by class id', async () => {
    prisma.registration.groupBy.mockResolvedValue([
      { classId: 10, _count: { _all: 3 } },
      { classId: 11, _count: { _all: 1 } },
    ]);

    const result = await service.getRegistrationCounts([10, 11]);

    expect(prisma.registration.groupBy).toHaveBeenCalledWith({
      by: ['classId'],
      where: { classId: { in: [10, 11] }, status: 'Registered' },
      _count: { _all: true },
    });
    expect(result).toEqual([
      { classId: 10, count: 3 },
      { classId: 11, count: 1 },
    ]);
  });

  it('returns registrations for a class', async () => {
    prisma.registration.findMany.mockResolvedValue([existing]);

    await expect(service.findRegistrations(10)).resolves.toEqual([existing]);
    expect(prisma.registration.findMany).toHaveBeenCalledWith({
      where: { classId: 10 },
    });
  });

  it('returns all registrations in reverse registration order', async () => {
    prisma.registration.findMany.mockResolvedValue([existing]);

    await expect(service.findAllRegistrations()).resolves.toEqual([existing]);
    expect(prisma.registration.findMany).toHaveBeenCalledWith({
      orderBy: [{ registeredAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('throws when a registration id does not exist', async () => {
    prisma.registration.findUnique.mockResolvedValue(null);

    await expect(service.findRegistration(99)).rejects.toMatchObject({
      message: 'Registration 99 not found',
    });
  });

  it('returns an empty array for no class ids', async () => {
    await expect(service.getRegistrationCounts([])).resolves.toEqual([]);
    expect(prisma.registration.groupBy).not.toHaveBeenCalled();
  });

  it('returns all registrations for a user', async () => {
    const regs = [
      { id: 1, classId: 10, userId: 'user-1', status: 'Registered' },
      { id: 2, classId: 11, userId: 'user-1', status: 'Registered' },
    ];
    prisma.registration.findMany.mockResolvedValue(regs);

    const result = await service.findRegistrationsByUser('user-1');

    expect(prisma.registration.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(result).toEqual(regs);
  });

  it('creates a registration when none exists', async () => {
    prisma.registration.findFirst.mockResolvedValue(null);
    prisma.registration.count.mockResolvedValue(0);
    prisma.registration.create.mockResolvedValue(existing);

    const result = await service.createRegistration(10, 'user-1', 10);

    expect(result).toEqual(existing);
    expect(prisma.registration.findFirst).toHaveBeenCalledWith({
      where: { classId: 10, userId: 'user-1' },
    });
    expect(prisma.registration.create).toHaveBeenCalledWith({
      data: {
        classId: 10,
        userId: 'user-1',
        status: 'Registered',
        waitlistedAt: null,
        source: 'member',
      },
    });
  });

  it('waitlists a registration when the class is full', async () => {
    prisma.registration.count.mockResolvedValue(10);
    prisma.registration.create.mockResolvedValue({
      ...existing,
      userId: 'user-2',
      status: 'Waitlisted',
    });

    await expect(
      service.createRegistration(10, 'user-2', 10),
    ).resolves.toMatchObject({
      status: 'Waitlisted',
    });
    expect(prisma.registration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'Waitlisted' }) as never,
    });
  });

  it('rejects a full class when waitlisting is disabled', async () => {
    prisma.registration.count.mockResolvedValue(10);

    await expect(
      service.createRegistration(10, 'user-2', 10, { waitlistEnabled: false }),
    ).rejects.toMatchObject({ message: 'Class is full' });
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('does not count canceled registrations toward capacity', async () => {
    prisma.registration.count.mockResolvedValue(0);
    prisma.registration.create.mockResolvedValue(existing);

    await service.createRegistration(10, 'user-2', 1);

    expect(prisma.registration.count).toHaveBeenCalledWith({
      where: { classId: 10, status: 'Registered' },
    });
  });

  it('reactivates a canceled registration', async () => {
    const canceled = { ...existing, status: 'Canceled' };
    prisma.registration.findFirst.mockResolvedValue(canceled);
    prisma.registration.count.mockResolvedValue(0);
    prisma.registration.update.mockResolvedValue(existing);

    await expect(service.createRegistration(10, 'user-1', 1)).resolves.toEqual(
      existing,
    );
    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        status: 'Registered',
        registeredAt: expect.any(Date) as never,
        waitlistedAt: null,
        promotedAt: null,
        canceledAt: null,
        cancellationReason: null,
        source: 'member',
      },
    });
    expect(prisma.registration.create).not.toHaveBeenCalled();
  });

  it('maps a database uniqueness race to a conflict', async () => {
    prisma.registration.create.mockRejectedValue({ code: 'P2002' });

    await expect(
      service.createRegistration(10, 'user-2', 10),
    ).rejects.toMatchObject({
      message: 'Already registered for this class',
    });
  });

  it('retries a serializable transaction conflict', async () => {
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    prisma.registration.findFirst.mockResolvedValue(null);
    prisma.registration.create.mockResolvedValue(existing);

    await expect(service.createRegistration(10, 'user-2', 10)).resolves.toEqual(
      existing,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('propagates a transaction conflict after retries', async () => {
    const conflict = { code: 'P2034' };
    prisma.$transaction.mockRejectedValue(conflict);

    await expect(service.createRegistration(10, 'user-2', 10)).rejects.toEqual(
      conflict,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
  });

  it('retries a conflict the pg adapter reports at commit', async () => {
    // Shape of the DriverAdapterError thrown when COMMIT fails with 40001.
    const commitConflict = Object.assign(
      new Error('TransactionWriteConflict'),
      {
        cause: { originalCode: '40001', kind: 'TransactionWriteConflict' },
      },
    );
    prisma.$transaction.mockRejectedValueOnce(commitConflict);
    prisma.registration.findFirst.mockResolvedValue(null);
    prisma.registration.count.mockResolvedValue(0);
    prisma.registration.create.mockResolvedValue(existing);

    await expect(service.createRegistration(10, 'user-2', 10)).resolves.toEqual(
      existing,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('retries a transaction Postgres aborted to break a deadlock', async () => {
    // Shape of the error Prisma throws for 40P01 through the pg adapter.
    const deadlock = {
      code: 'P2039',
      meta: {
        driverAdapterError: {
          cause: { originalCode: '40P01', kind: 'postgres' },
        },
      },
    };
    prisma.$transaction.mockRejectedValueOnce(deadlock);
    prisma.registration.findFirst.mockResolvedValue(null);
    prisma.registration.count.mockResolvedValue(0);
    prisma.registration.create.mockResolvedValue(existing);

    await expect(service.createRegistration(10, 'user-2', 10)).resolves.toEqual(
      existing,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate registration with 409', async () => {
    prisma.registration.findFirst.mockResolvedValue(existing);

    await expect(service.createRegistration(10, 'user-1', 10)).rejects.toThrow(
      RpcException,
    );
    await expect(
      service.createRegistration(10, 'user-1', 10),
    ).rejects.toMatchObject({
      message: 'Already registered for this class',
    });
  });

  it('returns the registration for a class/user pair', async () => {
    prisma.registration.findFirst.mockResolvedValue(existing);

    await expect(
      service.findRegistrationByClassAndUser(10, 'user-1'),
    ).resolves.toEqual(existing);
  });

  it('throws 404 when not registered for class/user', async () => {
    prisma.registration.findFirst.mockResolvedValue(null);

    await expect(
      service.findRegistrationByClassAndUser(10, 'user-1'),
    ).rejects.toMatchObject({
      message: 'Not registered for this class',
    });
  });

  it('cancels the registration for a class/user pair', async () => {
    prisma.registration.findFirst.mockResolvedValue(existing);
    prisma.registration.findUnique.mockResolvedValue(existing);
    prisma.registration.update.mockResolvedValue({
      ...existing,
      status: 'Canceled',
    });
    prisma.registration.findMany.mockResolvedValue([]);
    prisma.registration.count.mockResolvedValue(1);

    const result = await service.cancelRegistrationByClassAndUser(
      10,
      'user-1',
      {
        capacity: 10,
        source: 'admin',
        reason: 'No longer available',
      },
    );

    expect(prisma.registration.update).toHaveBeenCalledWith({
      where: { id: existing.id },
      data: expect.objectContaining({
        status: 'Canceled',
        cancellationReason: 'No longer available',
      }) as never,
    });
    expect(result).toMatchObject({ ...existing, status: 'Canceled' });
  });

  it('throws 404 when canceling a non-existent registration', async () => {
    prisma.registration.findFirst.mockResolvedValue(null);

    await expect(
      service.cancelRegistrationByClassAndUser(10, 'user-1', { capacity: 10 }),
    ).rejects.toMatchObject({
      message: 'Not registered for this class',
    });
  });

  it('rejects member cancellation after the cutoff', async () => {
    prisma.registration.findUnique.mockResolvedValue(existing);

    await expect(
      service.cancelRegistration(1, {
        capacity: 10,
        classStartAt: new Date(Date.now() + 60 * 60 * 1_000),
        cancellationCutoffHours: 24,
      }),
    ).rejects.toMatchObject({
      message: 'The cancellation window has closed',
    });
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('returns an already-canceled registration without applying the cutoff', async () => {
    const canceled = { ...existing, status: 'Canceled' };
    prisma.registration.findUnique.mockResolvedValue(canceled);

    await expect(
      service.cancelRegistration(1, {
        capacity: 10,
        classStartAt: new Date(Date.now() + 60 * 60 * 1_000),
        cancellationCutoffHours: 24,
      }),
    ).resolves.toEqual(canceled);
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  it('rejects destructive deletion', async () => {
    await expect(service.deleteRegistration(1)).rejects.toMatchObject({
      message: 'Registration 1 must be canceled, not deleted',
    });
    await expect(service.deleteClassRegistrations(10)).rejects.toMatchObject({
      message: 'Class 10 registrations must be canceled, not deleted',
    });
    await expect(
      service.deleteRegistrationByClassAndUser(),
    ).rejects.toMatchObject({
      message: 'Registrations must be canceled, not deleted',
    });
    expect(prisma.registration.update).not.toHaveBeenCalled();
  });

  describe('updateRegistration', () => {
    it('edits the cancellation reason', async () => {
      prisma.registration.update.mockResolvedValue(existing);

      await expect(
        service.updateRegistration(1, { cancellationReason: 'Injury' }),
      ).resolves.toEqual(existing);
      expect(prisma.registration.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { cancellationReason: 'Injury' },
      });
    });

    it('routes status changes to the lifecycle endpoints', async () => {
      await expect(
        service.updateRegistration(1, { status: 'Canceled' }),
      ).rejects.toMatchObject({
        message: 'Use the cancellation lifecycle endpoint to change status',
      });
    });

    it.each([
      { classId: 11 },
      { userId: 'user-2' },
      { registeredAt: '2000-01-01' },
      { id: 2 },
      { cancellationReason: 42 },
    ])('rejects lifecycle-owned or invalid field %o', async (data) => {
      await expect(service.updateRegistration(1, data)).rejects.toMatchObject({
        message: 'Only the cancellation reason can be edited',
      });
      expect(prisma.registration.update).not.toHaveBeenCalled();
    });

    it('maps a missing registration to not found', async () => {
      prisma.registration.update.mockRejectedValue({ code: 'P2025' });

      await expect(
        service.updateRegistration(9, { cancellationReason: null }),
      ).rejects.toMatchObject({ message: 'Registration 9 not found' });
    });
  });

  describe('payload validation', () => {
    // Prisma drops undefined filters, so each of these would otherwise
    // read or change registrations of every class or member.
    it.each([
      [
        'cancelClassRegistrations',
        () => service.cancelClassRegistrations(undefined as never),
      ],
      [
        'cancelRegistrationByClassAndUser',
        () =>
          service.cancelRegistrationByClassAndUser(10, undefined as never, {
            capacity: 10,
          }),
      ],
      [
        'findRegistrationByClassAndUser',
        () => service.findRegistrationByClassAndUser(10, undefined as never),
      ],
      [
        'findRegistrations',
        () => service.findRegistrations(undefined as never),
      ],
      [
        'findRegistrationsByUser',
        () => service.findRegistrationsByUser(undefined as never),
      ],
      [
        'promoteWaitlisted',
        () => service.promoteWaitlisted(undefined as never, 10),
      ],
      [
        'getRegistrationCounts',
        () => service.getRegistrationCounts([10, '11' as never]),
      ],
      [
        'createRegistration',
        () => service.createRegistration(10, undefined as never, 10),
      ],
      [
        'getClassLifecycleSummary',
        () => service.getClassLifecycleSummary(undefined as never),
      ],
    ])('%s rejects a missing id before querying', async (_label, call) => {
      await expect((call as () => Promise<unknown>)()).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
      expect(prisma.registration.findMany).not.toHaveBeenCalled();
      expect(prisma.registration.findFirst).not.toHaveBeenCalled();
      expect(prisma.registration.count).not.toHaveBeenCalled();
      expect(prisma.registration.groupBy).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('claimNotification', () => {
    it('takes over a pending or stale delivery atomically', async () => {
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.claimNotification('event-1')).resolves.toBe(true);
      expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
        where: {
          eventKey: 'event-1',
          OR: [
            { status: 'Pending' },
            {
              status: 'Processing',
              updatedAt: { lt: expect.any(Date) as unknown },
            },
          ],
        },
        data: { status: 'Processing' },
      });
      expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    });

    it('creates the delivery for a new event', async () => {
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
      prisma.notificationDelivery.create.mockResolvedValue({});

      await expect(service.claimNotification('event-1')).resolves.toBe(true);
      expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
        data: { eventKey: 'event-1', status: 'Processing' },
      });
    });

    it('does not claim a delivery that is sent or held by another consumer', async () => {
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
      prisma.notificationDelivery.create.mockRejectedValue({ code: 'P2002' });

      await expect(service.claimNotification('event-1')).resolves.toBe(false);
    });

    it('rethrows unexpected database errors', async () => {
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
      prisma.notificationDelivery.create.mockRejectedValue(new Error('db'));

      await expect(service.claimNotification('event-1')).rejects.toThrow('db');
    });

    it('requires an event key', async () => {
      await expect(service.claimNotification(' ')).rejects.toMatchObject({
        message: 'Notification event key is required',
      });
    });
  });

  it('promotes the earliest waitlisted member into an available seat', async () => {
    prisma.registration.count.mockResolvedValue(0);
    prisma.registration.findMany.mockResolvedValue([
      { id: 2, classId: 10, userId: 'user-2', status: 'Waitlisted' },
    ]);
    prisma.registration.update.mockResolvedValue({
      id: 2,
      classId: 10,
      userId: 'user-2',
      status: 'Registered',
    });

    await expect(service.promoteWaitlisted(10, 1)).resolves.toHaveLength(1);
    expect(prisma.registration.findMany).toHaveBeenCalledWith({
      where: { classId: 10, status: 'Waitlisted' },
      orderBy: [{ waitlistedAt: 'asc' }, { id: 'asc' }],
      take: 1,
    });
  });

  it('cancels all active registrations for a canceled class', async () => {
    const active = [
      { id: 1, classId: 10, userId: 'user-1', status: 'Registered' },
      { id: 2, classId: 10, userId: 'user-2', status: 'Waitlisted' },
    ];
    prisma.registration.findMany.mockResolvedValue(active);
    prisma.registration.update.mockResolvedValue({
      id: 1,
      classId: 10,
      userId: 'user-1',
      status: 'Canceled',
    });

    await expect(service.cancelClassRegistrations(10)).resolves.toEqual({
      canceled: 2,
    });
    expect(prisma.registration.update).toHaveBeenCalledTimes(2);
  });

  it('creates and lists contact submissions', async () => {
    const contact = {
      id: 1,
      name: 'Person',
      email: 'person@example.com',
      subject: 'Question',
      message: 'Hello',
    };
    prisma.contactSubmission.create.mockResolvedValue(contact);
    prisma.contactSubmission.findMany.mockResolvedValue([contact]);

    await expect(
      service.createContactSubmission({ ...contact, read: true } as never),
    ).resolves.toEqual(contact);
    expect(prisma.contactSubmission.create).toHaveBeenCalledWith({
      data: {
        name: 'Person',
        email: 'person@example.com',
        subject: 'Question',
        message: 'Hello',
      },
    });
    await expect(service.getContactSubmissions()).resolves.toEqual([contact]);
    expect(prisma.contactSubmission.findMany).toHaveBeenCalledWith({
      take: 50,
      skip: 0,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it.each([
    [0, 0],
    [101, 0],
    [null, 0],
    [10, -1],
    [10, 1.5],
  ])('rejects contact page take=%p skip=%p', async (take, skip) => {
    await expect(
      service.getContactSubmissions(take as never, skip),
    ).rejects.toMatchObject({ message: 'Contact submission page is invalid' });
    expect(prisma.contactSubmission.findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean read status', async () => {
    await expect(
      service.markContactSubmissionRead(7, 'yes' as never),
    ).rejects.toMatchObject({ message: 'Read status is invalid' });
    expect(prisma.contactSubmission.update).not.toHaveBeenCalled();
  });

  it('updates contact read status', async () => {
    const contact = { id: 7, read: false };
    prisma.contactSubmission.update.mockResolvedValue({
      ...contact,
      read: true,
    });

    await expect(service.markContactSubmissionRead(7, true)).resolves.toEqual({
      ...contact,
      read: true,
    });
    expect(prisma.contactSubmission.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { read: true },
    });
  });

  it('maps a missing contact submission to not found', async () => {
    prisma.contactSubmission.update.mockRejectedValue({ code: 'P2025' });

    await expect(
      service.markContactSubmissionRead(99, true),
    ).rejects.toMatchObject({
      message: 'Contact submission 99 not found',
    });
  });
});
