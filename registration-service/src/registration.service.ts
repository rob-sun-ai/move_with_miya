import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from './prisma/prisma.service';

class RpcError extends RpcException {
  constructor(statusCode: number, message: string) {
    super({ statusCode, message });
  }
}

/** Largest value a Postgres INTEGER column holds. */
const PG_INT_MAX = 2_147_483_647;

/**
 * Validates an id from an RPC payload. Prisma drops `undefined` filters, so a
 * missing id would otherwise widen a query or bulk update to every row.
 */
function assertRecordId(
  value: unknown,
  label: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > PG_INT_MAX
  ) {
    throw new RpcError(400, `${label} is invalid`);
  }
}

function assertKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError(400, `${label} is invalid`);
  }
}

function assertCapacity(capacity: unknown): asserts capacity is number {
  if (
    typeof capacity !== 'number' ||
    !Number.isInteger(capacity) ||
    capacity <= 0
  ) {
    throw new RpcError(400, 'Class capacity is invalid');
  }
}

function errorMessage(error: unknown) {
  return typeof error === 'string' ? error.slice(0, 500) : undefined;
}

const SERIALIZABLE_MAX_ATTEMPTS = 5;

/**
 * Whether a serializable transaction lost a race and can simply be rerun.
 * Prisma reports a conflict detected mid-transaction as P2034, but the pg
 * driver adapter surfaces one detected at COMMIT as a raw 40001 error. A
 * unique violation means a concurrent transaction inserted the row this one
 * checked for; rerunning it sees that row. A deadlock (40P01, reported as
 * P2039) aborts one of the transactions, which can likewise be rerun.
 */
function isRetryableConflict(error: unknown) {
  const { code, cause, meta } = (error ?? {}) as {
    code?: string;
    cause?: { originalCode?: string; kind?: string };
    meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
  };
  return (
    code === 'P2034' ||
    code === 'P2002' ||
    cause?.originalCode === '40001' ||
    cause?.kind === 'TransactionWriteConflict' ||
    meta?.driverAdapterError?.cause?.originalCode === '40P01'
  );
}

/** Registration fields an administrator may edit directly. */
const EDITABLE_REGISTRATION_FIELDS = new Set(['cancellationReason']);

/** A notification claim older than this is presumed abandoned. */
const NOTIFICATION_LEASE_MS = 5 * 60 * 1_000;

const MAX_CONTACT_PAGE_SIZE = 100;

@Injectable()
export class RegistrationService {
  constructor(private readonly prisma: PrismaService) {}

  private addOutboxEvent(
    tx: {
      outboxEvent: {
        create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
      };
    },
    registration: { id: number; classId: number; userId: string },
    eventType: string,
    eventKey: string,
    extra: Record<string, unknown> = {},
  ) {
    return tx.outboxEvent.create({
      data: {
        eventKey,
        eventType,
        aggregateId: String(registration.id),
        payload: {
          registrationId: registration.id,
          classId: registration.classId,
          userId: registration.userId,
          ...extra,
        },
      },
    });
  }

  async findRegistrations(classId: number) {
    assertRecordId(classId, 'Class');
    return this.prisma.client.registration.findMany({
      where: { classId },
    });
  }

  async findRegistrationsByUser(userId: string) {
    assertKey(userId, 'User');
    return this.prisma.client.registration.findMany({
      where: { userId },
    });
  }

  findAllRegistrations() {
    return this.prisma.client.registration.findMany({
      orderBy: [{ registeredAt: 'desc' }, { id: 'desc' }],
    });
  }

  async getRegistrationCounts(classIds: number[]) {
    if (!Array.isArray(classIds)) {
      throw new RpcError(400, 'Class ids are invalid');
    }
    classIds.forEach((classId) => assertRecordId(classId, 'Class'));
    if (classIds.length === 0) return [];
    const grouped = await this.prisma.client.registration.groupBy({
      by: ['classId'],
      where: { classId: { in: classIds }, status: 'Registered' },
      _count: { _all: true },
    });
    return grouped.map((g) => ({
      classId: g.classId,
      count: g._count._all,
    }));
  }

  async findRegistration(id: number) {
    assertRecordId(id, 'Registration');
    const reg = await this.prisma.client.registration.findUnique({
      where: { id },
    });
    if (!reg) throw new RpcError(404, `Registration ${id} not found`);
    return reg;
  }

  async createRegistration(
    classId: number,
    userId: string,
    capacity: number,
    options: {
      waitlistEnabled?: boolean;
      source?: string;
    } = {},
  ) {
    assertRecordId(classId, 'Class');
    assertKey(userId, 'User');
    assertCapacity(capacity);

    try {
      return await this.runSerializable(async (tx) => {
        const existing = await tx.registration.findFirst({
          where: { classId, userId },
        });
        if (existing?.status === 'Registered') {
          throw new RpcError(409, 'Already registered for this class');
        }
        if (existing?.status === 'Waitlisted') {
          throw new RpcError(409, 'Already waitlisted for this class');
        }

        const registeredCount = await tx.registration.count({
          where: { classId, status: 'Registered' },
        });
        const registered = registeredCount < capacity;
        if (!registered && options.waitlistEnabled === false) {
          throw new RpcError(409, 'Class is full');
        }
        const now = new Date();
        const status = registered ? 'Registered' : 'Waitlisted';
        const source = options.source ?? 'member';

        const result = existing
          ? await tx.registration.update({
              where: { id: existing.id },
              data: {
                status,
                registeredAt: registered ? now : existing.registeredAt,
                waitlistedAt: registered ? null : now,
                promotedAt: null,
                canceledAt: null,
                cancellationReason: null,
                source,
              },
            })
          : await tx.registration.create({
              data: {
                classId,
                userId,
                status,
                waitlistedAt: registered ? null : now,
                source,
              },
            });
        await this.addOutboxEvent(
          tx,
          result,
          registered ? 'registration.confirmed' : 'registration.waitlisted',
          `registration:${result.id}:${status}:${now.toISOString()}`,
        );
        return result;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new RpcError(409, 'Already registered for this class');
      }
      throw error;
    }
  }

  async findRegistrationByClassAndUser(classId: number, userId: string) {
    assertRecordId(classId, 'Class');
    assertKey(userId, 'User');
    const reg = await this.prisma.client.registration.findFirst({
      where: { classId, userId },
    });
    if (!reg) {
      throw new RpcError(404, 'Not registered for this class');
    }
    if (reg.status !== 'Waitlisted') return reg;
    const ahead = await this.prisma.client.registration.count({
      where: {
        classId,
        status: 'Waitlisted',
        OR: [
          { waitlistedAt: { lt: reg.waitlistedAt ?? new Date() } },
          {
            waitlistedAt: reg.waitlistedAt,
            id: { lt: reg.id },
          },
        ],
      },
    });
    return { ...reg, waitlistPosition: ahead + 1 };
  }

  async cancelRegistrationByClassAndUser(
    classId: number,
    userId: string,
    options: {
      capacity: number;
      classStartAt?: string | Date;
      cancellationCutoffHours?: number;
      source?: string;
      reason?: string;
    },
  ) {
    return this.cancelRegistration(
      await this.findRegistrationId(classId, userId),
      options,
    );
  }

  private async findRegistrationId(classId: number, userId: string) {
    // Without these checks an undefined user would match, and cancel,
    // another member's registration.
    assertRecordId(classId, 'Class');
    assertKey(userId, 'User');
    const reg = await this.prisma.client.registration.findFirst({
      where: { classId, userId },
    });
    if (!reg) throw new RpcError(404, 'Not registered for this class');
    return reg.id;
  }

  async cancelRegistration(
    id: number,
    options: {
      capacity: number;
      classStartAt?: string | Date;
      cancellationCutoffHours?: number;
      source?: string;
      reason?: string;
    },
  ) {
    assertRecordId(id, 'Registration');
    assertCapacity(options.capacity);
    const cutoffHours = options.cancellationCutoffHours ?? 24;
    if (!Number.isInteger(cutoffHours) || cutoffHours < 0) {
      throw new RpcError(400, 'Cancellation cutoff is invalid');
    }
    const classStart = options.classStartAt
      ? new Date(options.classStartAt).getTime()
      : undefined;
    const cutoff =
      classStart === undefined
        ? undefined
        : classStart - cutoffHours * 60 * 60 * 1000;
    if (classStart !== undefined && Number.isNaN(classStart)) {
      throw new RpcError(400, 'Class start time is invalid');
    }

    return this.runSerializable(async (tx) => {
      const current = await tx.registration.findUnique({ where: { id } });
      if (!current) throw new RpcError(404, `Registration ${id} not found`);
      if (current.status === 'Canceled') return current;
      if (
        options.source !== 'admin' &&
        cutoff !== undefined &&
        Date.now() >= cutoff
      ) {
        throw new RpcError(403, 'The cancellation window has closed');
      }

      const now = new Date();
      const result = await tx.registration.update({
        where: { id },
        data: {
          status: 'Canceled',
          canceledAt: now,
          cancellationReason: options.reason ?? 'Member cancellation',
          source: options.source ?? 'member',
        },
      });
      await this.addOutboxEvent(
        tx,
        result,
        'registration.canceled',
        `registration:${id}:canceled:${now.toISOString()}`,
      );
      if (current.status === 'Registered') {
        await this.promoteWaitlistedInTransaction(
          tx,
          current.classId,
          options.capacity,
        );
      }
      return result;
    });
  }

  async cancelClassRegistrations(
    classId: number,
    reason = 'Class canceled',
    source = 'class-cancellation',
  ) {
    // Without this check an undefined id would cancel every class.
    assertRecordId(classId, 'Class');
    return this.runSerializable(async (tx) => {
      const active = await tx.registration.findMany({
        where: { classId, status: { in: ['Registered', 'Waitlisted'] } },
      });
      const now = new Date();
      for (const registration of active) {
        const result = await tx.registration.update({
          where: { id: registration.id },
          data: {
            status: 'Canceled',
            canceledAt: now,
            cancellationReason: reason,
            source,
          },
        });
        await this.addOutboxEvent(
          tx,
          result,
          'class.canceled.registration',
          `registration:${result.id}:class-canceled:${now.toISOString()}`,
          { reason },
        );
      }
      return { canceled: active.length };
    });
  }

  private async promoteWaitlistedInTransaction(
    tx: typeof this.prisma.client,
    classId: number,
    capacity: number,
  ) {
    const registeredCount = await tx.registration.count({
      where: { classId, status: 'Registered' },
    });
    const seats = Math.max(0, capacity - registeredCount);
    if (seats === 0) return [];

    const waitlisted = await tx.registration.findMany({
      where: { classId, status: 'Waitlisted' },
      orderBy: [{ waitlistedAt: 'asc' }, { id: 'asc' }],
      take: seats,
    });
    const promoted: unknown[] = [];
    for (const registration of waitlisted) {
      const now = new Date();
      const result = await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: 'Registered',
          registeredAt: now,
          promotedAt: now,
          waitlistedAt: null,
        },
      });
      await this.addOutboxEvent(
        tx,
        result,
        'registration.promoted',
        `registration:${result.id}:promoted:${now.toISOString()}`,
      );
      promoted.push(result);
    }
    return promoted;
  }

  async promoteWaitlisted(classId: number, capacity: number) {
    assertRecordId(classId, 'Class');
    assertCapacity(capacity);
    return this.runSerializable((tx) =>
      this.promoteWaitlistedInTransaction(tx, classId, capacity),
    );
  }

  private async runSerializable<T>(
    callback: (tx: typeof this.prisma.client) => Promise<T>,
  ) {
    for (let attempt = 1; attempt <= SERIALIZABLE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.client.$transaction(callback, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        if (
          !isRetryableConflict(error) ||
          attempt === SERIALIZABLE_MAX_ATTEMPTS
        ) {
          throw error;
        }
        // Jitter keeps the conflicting transactions from colliding again.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * 25 * attempt),
        );
      }
    }
    throw new Error('Serializable transaction did not complete');
  }

  async updateRegistration(id: number, data: Record<string, unknown>) {
    assertRecordId(id, 'Registration');
    if ('status' in data) {
      throw new RpcError(
        400,
        'Use the cancellation lifecycle endpoint to change status',
      );
    }
    // Every other field is owned by the registration lifecycle; changing
    // the class, member, or timestamps directly would bypass capacity,
    // waitlist order, and the payment link.
    const fields = Object.keys(data);
    if (
      fields.some((field) => !EDITABLE_REGISTRATION_FIELDS.has(field)) ||
      (data.cancellationReason !== undefined &&
        data.cancellationReason !== null &&
        typeof data.cancellationReason !== 'string')
    ) {
      throw new RpcError(400, 'Only the cancellation reason can be edited');
    }
    try {
      return await this.prisma.client.registration.update({
        where: { id },
        data: {
          cancellationReason: data.cancellationReason,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new RpcError(404, `Registration ${id} not found`);
      }
      throw error;
    }
  }

  deleteRegistration(id: number) {
    return Promise.reject(
      new RpcError(409, `Registration ${id} must be canceled, not deleted`),
    );
  }

  deleteClassRegistrations(classId: number) {
    return Promise.reject(
      new RpcError(
        409,
        `Class ${classId} registrations must be canceled, not deleted`,
      ),
    );
  }

  deleteRegistrationByClassAndUser() {
    return Promise.reject(
      new RpcError(409, 'Registrations must be canceled, not deleted'),
    );
  }

  async getClassLifecycleSummary(classId: number) {
    assertRecordId(classId, 'Class');
    const [total, active] = await Promise.all([
      this.prisma.client.registration.count({ where: { classId } }),
      this.prisma.client.registration.count({
        where: { classId, status: { in: ['Registered', 'Waitlisted'] } },
      }),
    ]);
    return { classId, total, active };
  }

  async claimNotification(eventKey: string) {
    if (typeof eventKey !== 'string' || !eventKey.trim()) {
      throw new RpcError(400, 'Notification event key is required');
    }
    // Compare-and-set, so concurrent deliveries of one event cannot both
    // claim it: only a pending delivery, or one whose sender stalled past
    // the lease, is taken over.
    const { count } = await this.prisma.client.notificationDelivery.updateMany({
      where: {
        eventKey,
        OR: [
          { status: 'Pending' },
          {
            status: 'Processing',
            updatedAt: {
              lt: new Date(Date.now() - NOTIFICATION_LEASE_MS),
            },
          },
        ],
      },
      data: { status: 'Processing' },
    });
    if (count > 0) return true;
    try {
      await this.prisma.client.notificationDelivery.create({
        data: { eventKey, status: 'Processing' },
      });
      return true;
    } catch (error) {
      // The delivery exists and is sent or held by another consumer.
      if ((error as { code?: string }).code === 'P2002') return false;
      throw error;
    }
  }

  async completeNotification(eventKey: string) {
    assertKey(eventKey, 'Notification event key');
    return this.prisma.client.notificationDelivery.update({
      where: { eventKey },
      data: { status: 'Sent', sentAt: new Date(), lastError: null },
    });
  }

  async failNotification(eventKey: string, error: string) {
    assertKey(eventKey, 'Notification event key');
    return this.prisma.client.notificationDelivery.update({
      where: { eventKey },
      data: {
        status: 'Pending',
        attempts: { increment: 1 },
        lastError: errorMessage(error),
      },
    });
  }

  async createContactSubmission(data: {
    name: string;
    email: string;
    subject: string;
    message: string;
  }) {
    const { name, email, subject, message } = data;
    if (
      ![name, email, subject, message].every(
        (value) => typeof value === 'string',
      )
    ) {
      throw new RpcError(400, 'Contact submission is invalid');
    }
    // Only the submitted fields; never `read` or `id` from the payload.
    return this.prisma.client.contactSubmission.create({
      data: { name, email, subject, message },
    });
  }

  async getContactSubmissions(take: number = 50, skip: number = 0) {
    if (
      !Number.isInteger(take) ||
      take < 1 ||
      take > MAX_CONTACT_PAGE_SIZE ||
      !Number.isInteger(skip) ||
      skip < 0
    ) {
      throw new RpcError(400, 'Contact submission page is invalid');
    }
    return this.prisma.client.contactSubmission.findMany({
      take,
      skip,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async markContactSubmissionRead(id: number, read: boolean) {
    assertRecordId(id, 'Contact submission');
    if (typeof read !== 'boolean') {
      throw new RpcError(400, 'Read status is invalid');
    }
    try {
      return await this.prisma.client.contactSubmission.update({
        where: { id },
        data: { read },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') {
        throw new RpcError(404, `Contact submission ${id} not found`);
      }
      throw error;
    }
  }
}
