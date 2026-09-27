import { of, throwError } from 'rxjs';
import { ClassesController } from './ClassesController';

describe('ClassesController', () => {
  let controller: ClassesController;
  let classesClient: { send: jest.Mock };
  let registrationClient: { send: jest.Mock };

  beforeEach(() => {
    classesClient = { send: jest.fn() };
    registrationClient = { send: jest.fn() };
    registrationClient.send.mockReturnValue(of({ total: 0, active: 0 }));
    controller = new ClassesController(
      classesClient as never,
      registrationClient as never,
    );
    process.env.USER_SERVICE_URL = 'http://users.test';
    jest.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.USER_SERVICE_URL;
  });

  it('enriches class lists with registration counts and teachers', async () => {
    const classes = [
      {
        id: 1,
        name: 'Flow',
        teacherIds: ['teacher-1', 'teacher-2'],
        capacity: 10,
        cost: '20',
        description: '',
        duration: 60,
        startDate: '2026-09-10T10:00:00.000Z',
        endDate: '2026-09-10T11:00:00.000Z',
        status: 'Scheduled',
        locationId: 1,
        location: {},
        isPrivate: false,
      },
    ];
    classesClient.send.mockReturnValue(of(classes));
    registrationClient.send.mockReturnValue(of([{ classId: 1, count: 4 }]));
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'teacher-1',
            firstName: 'A',
            lastName: 'Teacher',
            role: 'TEACHER',
          },
        ]),
      ),
    );

    await expect(controller.findClasses()).resolves.toEqual([
      expect.objectContaining({
        registrationCount: 4,
        teachers: [
          {
            id: 'teacher-1',
            firstName: 'A',
            lastName: 'Teacher',
            role: 'TEACHER',
          },
        ],
      }),
    ]);
    expect(classesClient.send).toHaveBeenCalledWith({ cmd: 'get_classes' }, {});
    expect(registrationClient.send).toHaveBeenCalledWith(
      { cmd: 'get_registration_counts' },
      { classIds: [1] },
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://users.test/users/batch?ids=teacher-1%2Cteacher-2',
      { cache: 'no-store' },
    );
  });

  it('returns empty lists without making enrichment calls', async () => {
    classesClient.send.mockReturnValue(of([]));
    await expect(controller.findClasses()).resolves.toEqual([]);
    expect(registrationClient.send).not.toHaveBeenCalled();
  });

  it('forwards range and single-class reads', async () => {
    classesClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
      of(cmd === 'get_class' ? null : []),
    );

    await expect(
      controller.findClassesInRange('2026-09-01', '2026-09-30'),
    ).resolves.toEqual([]);
    await expect(controller.findClass(7)).resolves.toBeNull();
    expect(classesClient.send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'get_classes_in_range' },
      { from: '2026-09-01', to: '2026-09-30' },
    );
    expect(classesClient.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'get_class' },
      { id: 7 },
    );
  });

  it('forwards admin class mutations with the route id', async () => {
    classesClient.send.mockImplementation(() => of('ok'));
    await expect(controller.createClass({ name: 'Flow' })).resolves.toBe('ok');
    await expect(controller.updateClass(2, { name: 'New name' })).resolves.toBe(
      'ok',
    );
    await expect(controller.deleteClass(2)).resolves.toBe('ok');
    expect(classesClient.send).toHaveBeenCalledWith(
      { cmd: 'update_class' },
      { name: 'New name', id: 2 },
    );
    expect(classesClient.send).toHaveBeenCalledWith(
      { cmd: 'delete_class' },
      { id: 2 },
    );
  });

  it('cancels a class before resolving its active registrations', async () => {
    const cls = { id: 2, status: 'Scheduled' };
    classesClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
      of(cmd === 'get_class' ? cls : { ...cls, status: 'Canceled' }),
    );

    await expect(
      controller.cancelClass(2, { reason: 'Instructor unavailable' }),
    ).resolves.toMatchObject({ status: 'Canceled' });
    expect(registrationClient.send).toHaveBeenCalledWith(
      { cmd: 'cancel_class_registrations' },
      {
        classId: 2,
        reason: 'Instructor unavailable',
        source: 'class-cancellation',
      },
    );
  });

  it('restores the class status when registrations cannot be canceled', async () => {
    const cls = { id: 2, status: 'Scheduled' };
    classesClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
      of(cmd === 'get_class' ? cls : { ...cls, status: 'Canceled' }),
    );
    registrationClient.send.mockReturnValue(
      throwError(() => ({ statusCode: 503, message: 'down' })),
    );

    await expect(controller.cancelClass(2, {})).rejects.toBeDefined();
    expect(classesClient.send).toHaveBeenLastCalledWith(
      { cmd: 'update_class' },
      { id: 2, status: 'Scheduled' },
    );
  });

  it('refunds paid registrations after canceling the class', async () => {
    const stripeService = { refundClassPayments: jest.fn() };
    controller = new ClassesController(
      classesClient as never,
      registrationClient as never,
      stripeService as never,
    );
    classesClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
      of(cmd === 'get_class' ? { id: 2, status: 'Scheduled' } : { id: 2 }),
    );

    await controller.cancelClass(2, {});

    expect(stripeService.refundClassPayments).toHaveBeenCalledWith(2);
  });

  it('does not refund when registrations could not be canceled', async () => {
    const stripeService = { refundClassPayments: jest.fn() };
    controller = new ClassesController(
      classesClient as never,
      registrationClient as never,
      stripeService as never,
    );
    classesClient.send.mockImplementation(({ cmd }: { cmd: string }) =>
      of(cmd === 'get_class' ? { id: 2, status: 'Scheduled' } : { id: 2 }),
    );
    registrationClient.send.mockReturnValue(
      throwError(() => ({ statusCode: 503, message: 'down' })),
    );

    await expect(controller.cancelClass(2, {})).rejects.toBeDefined();
    expect(stripeService.refundClassPayments).not.toHaveBeenCalled();
  });

  it('reports the original error when restoring the class also fails', async () => {
    const originalError = { statusCode: 503, message: 'registrations down' };
    classesClient.send.mockImplementation(
      ({ cmd }: { cmd: string }, payload: { status?: string }) =>
        cmd === 'get_class'
          ? of({ id: 2, status: 'Scheduled' })
          : payload.status === 'Scheduled'
            ? throwError(() => new Error('classes down'))
            : of({ id: 2, status: 'Canceled' }),
    );
    registrationClient.send.mockReturnValue(throwError(() => originalError));

    await expect(controller.cancelClass(2, {})).rejects.toBe(originalError);
    expect(classesClient.send).toHaveBeenLastCalledWith(
      { cmd: 'update_class' },
      { id: 2, status: 'Scheduled' },
    );
  });
});
