import { Controller } from '@nestjs/common';
import { EventPattern } from '@nestjs/microservices';
import { RegistrationNotificationService } from './registration-notification.service';

@Controller()
export class RegistrationEventsController {
  constructor(
    private readonly notifications: RegistrationNotificationService,
  ) {}

  @EventPattern({ event: 'registration.lifecycle' })
  async handle(event: {
    eventKey: string;
    eventType: string;
    payload: { userId: string; classId: number; reason?: string };
  }) {
    if (!(await this.notifications.claim(event.eventKey))) return;
    try {
      await this.notifications.deliver(event);
      await this.notifications.complete(event.eventKey);
    } catch (error) {
      // Rethrow the delivery error even when recording it fails too.
      await this.notifications
        .fail(
          event.eventKey,
          error instanceof Error
            ? error.message
            : 'Notification delivery failed',
        )
        .catch(() => undefined);
      throw error;
    }
  }
}
