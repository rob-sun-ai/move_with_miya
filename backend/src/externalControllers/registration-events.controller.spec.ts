import { RegistrationEventsController } from './registration-events.controller';

describe('RegistrationEventsController', () => {
  const event = {
    eventKey: 'registration.confirmed:1',
    eventType: 'registration.confirmed',
    payload: { userId: 'user-1', classId: 1 },
  };

  function setup() {
    const notifications = {
      claim: jest.fn().mockResolvedValue(true),
      deliver: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    return {
      notifications,
      controller: new RegistrationEventsController(notifications as never),
    };
  }

  it('delivers a claimed event and marks it sent', async () => {
    const { controller, notifications } = setup();

    await controller.handle(event);

    expect(notifications.deliver).toHaveBeenCalledWith(event);
    expect(notifications.complete).toHaveBeenCalledWith(event.eventKey);
  });

  it('skips an event another consumer already claimed', async () => {
    const { controller, notifications } = setup();
    notifications.claim.mockResolvedValue(false);

    await controller.handle(event);

    expect(notifications.deliver).not.toHaveBeenCalled();
  });

  it('records a failed delivery and rethrows it', async () => {
    const { controller, notifications } = setup();
    const error = new Error('Resend rejected notification (500)');
    notifications.deliver.mockRejectedValue(error);

    await expect(controller.handle(event)).rejects.toBe(error);
    expect(notifications.fail).toHaveBeenCalledWith(
      event.eventKey,
      error.message,
    );
    expect(notifications.complete).not.toHaveBeenCalled();
  });

  it('rethrows the delivery error even when recording it fails', async () => {
    const { controller, notifications } = setup();
    const error = new Error('Resend rejected notification (500)');
    notifications.deliver.mockRejectedValue(error);
    notifications.fail.mockRejectedValue(new Error('registrations down'));

    await expect(controller.handle(event)).rejects.toBe(error);
  });
});
