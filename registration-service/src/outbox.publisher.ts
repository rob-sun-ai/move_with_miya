import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from './prisma/prisma.service';

/** How long a claimed event stays hidden from other replicas. */
export const OUTBOX_CLAIM_LEASE_MS = 30_000;

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REGISTRATION_EVENTS') private readonly events: ClientProxy,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.publish(), 2_000);
    void this.publish();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async publish() {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.prisma.client.outboxEvent.findMany({
        where: { processedAt: null, availableAt: { lte: new Date() } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 25,
      });
      for (const event of events) {
        // Another replica may have read the same batch; only the one whose
        // compare-and-set wins publishes the event. A replica that dies
        // mid-publish releases it when the lease runs out.
        const claim = await this.prisma.client.outboxEvent.updateMany({
          where: {
            id: event.id,
            processedAt: null,
            availableAt: event.availableAt,
          },
          data: { availableAt: new Date(Date.now() + OUTBOX_CLAIM_LEASE_MS) },
        });
        if (claim.count === 0) continue;
        try {
          await firstValueFrom(
            this.events.emit(
              { event: 'registration.lifecycle' },
              {
                eventId: event.id,
                eventKey: event.eventKey,
                eventType: event.eventType,
                aggregateId: event.aggregateId,
                payload: event.payload,
              },
            ),
          );
          await this.prisma.client.outboxEvent.update({
            where: { id: event.id },
            data: { processedAt: new Date() },
          });
        } catch {
          await this.prisma.client.outboxEvent.update({
            where: { id: event.id },
            data: {
              attempts: { increment: 1 },
              availableAt: new Date(
                Date.now() + 2 ** Math.min(event.attempts, 6) * 1_000,
              ),
            },
          });
        }
      }
    } catch (error) {
      // Called from a timer: a rejection here would be unhandled and stop
      // the process. Unpublished events are retried on the next tick.
      this.logger.warn(
        `Outbox publish failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
