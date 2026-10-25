jest.mock('./prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OUTBOX_CLAIM_LEASE_MS, OutboxPublisher } from './outbox.publisher';

const NOW = new Date('2026-09-27T12:00:00.000Z');

function outboxEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    eventKey: 'registration:1:Registered:2026-09-27T11:59:00.000Z',
    eventType: 'registration.confirmed',
    aggregateId: '1',
    payload: { registrationId: 1, classId: 10, userId: 'user-1' },
    attempts: 0,
    availableAt: new Date('2026-09-27T11:59:00.000Z'),
    processedAt: null,
    ...overrides,
  };
}

describe('OutboxPublisher', () => {
  let outbox: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
  let events: { emit: jest.Mock };
  let publisher: OutboxPublisher;
  const publish = () =>
    (publisher as unknown as { publish(): Promise<void> }).publish();

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    outbox = {
      findMany: jest.fn().mockResolvedValue([outboxEvent()]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    };
    events = { emit: jest.fn().mockReturnValue(of(undefined)) };
    publisher = new OutboxPublisher(
      { client: { outboxEvent: outbox } } as never,
      events as never,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('claims each event before publishing it, then marks it processed', async () => {
    await publish();

    expect(outbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'event-1',
        processedAt: null,
        availableAt: new Date('2026-09-27T11:59:00.000Z'),
      },
      data: {
        availableAt: new Date(NOW.getTime() + OUTBOX_CLAIM_LEASE_MS),
      },
    });
    expect(events.emit).toHaveBeenCalledWith(
      { event: 'registration.lifecycle' },
      expect.objectContaining({
        eventId: 'event-1',
        eventType: 'registration.confirmed',
      }),
    );
    expect(outbox.update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: { processedAt: NOW },
    });
  });

  it('skips an event another replica claimed first', async () => {
    outbox.updateMany.mockResolvedValue({ count: 0 });

    await publish();

    expect(events.emit).not.toHaveBeenCalled();
    expect(outbox.update).not.toHaveBeenCalled();
  });

  it('backs off exponentially after a failed publish', async () => {
    outbox.findMany.mockResolvedValue([outboxEvent({ attempts: 3 })]);
    events.emit.mockReturnValue(throwError(() => new Error('broker down')));

    await publish();

    expect(outbox.update).toHaveBeenCalledWith({
      where: { id: 'event-1' },
      data: {
        attempts: { increment: 1 },
        availableAt: new Date(NOW.getTime() + 8_000),
      },
    });
  });

  it('does not reject when the database is unavailable', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    outbox.findMany.mockRejectedValue(new Error('db down'));

    await expect(publish()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Outbox publish failed: db down');
    warn.mockRestore();
    // The guard is released so the next tick tries again.
    outbox.findMany.mockResolvedValue([]);
    await publish();
    expect(outbox.findMany).toHaveBeenCalledTimes(2);
  });

  it('runs one publish at a time', async () => {
    const first = publish();
    const second = publish();
    await Promise.all([first, second]);

    expect(outbox.findMany).toHaveBeenCalledTimes(1);
  });
});
