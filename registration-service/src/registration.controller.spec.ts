jest.mock('./prisma/prisma.service', () => ({ PrismaService: class {} }));

import { RegistrationController } from './registration.controller';

describe('RegistrationController', () => {
  let controller: RegistrationController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = Object.fromEntries(
      [
        'findRegistrations',
        'findRegistration',
        'findRegistrationsByUser',
        'findAllRegistrations',
        'getRegistrationCounts',
        'findRegistrationByClassAndUser',
        'cancelRegistrationByClassAndUser',
        'cancelRegistration',
        'cancelClassRegistrations',
        'promoteWaitlisted',
        'getClassLifecycleSummary',
        'updateRegistration',
        'deleteRegistration',
        'deleteClassRegistrations',
        'deleteRegistrationByClassAndUser',
        'createContactSubmission',
        'getContactSubmissions',
        'markContactSubmissionRead',
        'createRegistration',
      ].map((name) => [name, jest.fn()]),
    ) as Record<string, jest.Mock>;
    controller = new RegistrationController(service as never);
  });

  const invoke: Record<string, (input: unknown) => unknown> = {
    findRegistrations: (input) =>
      controller.findRegistrations(input as { classId: number }),
    findRegistration: (input) =>
      controller.findRegistration(input as { id: number }),
    findRegistrationsByUser: (input) =>
      controller.findRegistrationsByUser(input as { userId: string }),
    findRegistrationByClassAndUser: (input) =>
      controller.findRegistrationByClassAndUser(
        input as { classId: number; userId: string },
      ),
    cancelRegistrationByClassAndUser: (input) =>
      controller.cancelRegistrationByClassAndUser(
        input as {
          classId: number;
          userId: string;
          capacity: number;
        },
      ),
    deleteRegistration: (input) =>
      controller.deleteRegistration(input as { id: number }),
    deleteClassRegistrations: (input) =>
      controller.deleteClassRegistrations(input as { classId: number }),
    getRegistrationCounts: (input) =>
      controller.getRegistrationCounts(input as { classIds: number[] }),
    getContactSubmissions: (input) =>
      controller.getContactSubmissions(
        input as { take?: number; skip?: number },
      ),
    markContactSubmissionRead: (input) =>
      controller.markContactSubmissionRead(
        input as { id: number; read: boolean },
      ),
  };

  it.each([
    ['findRegistrations', { classId: 1 }, 'findRegistrations', [1]],
    ['findRegistration', { id: 2 }, 'findRegistration', [2]],
    [
      'findRegistrationsByUser',
      { userId: 'user-1' },
      'findRegistrationsByUser',
      ['user-1'],
    ],
    [
      'findRegistrationByClassAndUser',
      { classId: 1, userId: 'user-1' },
      'findRegistrationByClassAndUser',
      [1, 'user-1'],
    ],
    [
      'cancelRegistrationByClassAndUser',
      { classId: 1, userId: 'user-1', capacity: 10 },
      'cancelRegistrationByClassAndUser',
      [1, 'user-1', { classId: 1, userId: 'user-1', capacity: 10 }],
    ],
    ['deleteRegistration', { id: 2 }, 'deleteRegistration', [2]],
    [
      'deleteClassRegistrations',
      { classId: 1 },
      'deleteClassRegistrations',
      [1],
    ],
    [
      'getRegistrationCounts',
      { classIds: [1, 2] },
      'getRegistrationCounts',
      [[1, 2]],
    ],
    [
      'getContactSubmissions',
      { take: 10, skip: 5 },
      'getContactSubmissions',
      [10, 5],
    ],
    [
      'markContactSubmissionRead',
      { id: 3, read: true },
      'markContactSubmissionRead',
      [3, true],
    ],
  ])('forwards %s', async (method, input, serviceMethod, args) => {
    service[serviceMethod].mockResolvedValue('result');
    const result = await invoke[method](input);
    expect(result).toBe('result');
    expect(service[serviceMethod]).toHaveBeenCalledWith(...args);
  });

  it('forwards registration creation while ignoring extra transport fields', async () => {
    service.createRegistration.mockResolvedValue('created');
    await expect(
      controller.createRegistration({
        classId: 1,
        userId: 'user-1',
        capacity: 12,
        ignored: true,
      }),
    ).resolves.toBe('created');
    expect(service.createRegistration).toHaveBeenCalledWith(1, 'user-1', 12, {
      waitlistEnabled: undefined,
      source: undefined,
    });
  });

  it('splits ids from update payloads before forwarding', async () => {
    service.updateRegistration.mockResolvedValue('updated');

    await expect(
      controller.updateRegistration({ id: 4, cancellationReason: 'Injury' }),
    ).resolves.toBe('updated');
    expect(service.updateRegistration).toHaveBeenCalledWith(4, {
      cancellationReason: 'Injury',
    });
  });

  it('forwards contact submissions', async () => {
    const contact = {
      name: 'Person',
      email: 'person@example.com',
      subject: 'Hi',
      message: 'Hello',
    };
    service.createContactSubmission.mockResolvedValue('contact');

    await expect(controller.createContactSubmission(contact)).resolves.toBe(
      'contact',
    );
    expect(service.createContactSubmission).toHaveBeenCalledWith(contact);
  });

  it('rejects the legacy class/user delete instead of guessing capacity', async () => {
    service.deleteRegistrationByClassAndUser.mockRejectedValue(
      new Error('Registrations must be canceled, not deleted'),
    );

    await expect(controller.deleteRegistrationByClassAndUser()).rejects.toThrow(
      'Registrations must be canceled, not deleted',
    );
    expect(service.cancelRegistrationByClassAndUser).not.toHaveBeenCalled();
  });
});
