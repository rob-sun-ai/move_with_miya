import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { sendRpc } from '../common/rpc';
import { userServiceUrl } from '../common/user-verification';

interface RegistrationEvent {
  eventKey: string;
  eventType: string;
  payload: {
    userId: string;
    classId: number;
    reason?: string;
  };
}

interface UserRecord {
  email?: string;
  firstName?: string;
}

interface ClassRecord {
  name?: string;
  startDate?: string;
  location?: { name?: string; city?: string; state?: string };
}

@Injectable()
export class RegistrationNotificationService {
  private readonly logger = new Logger(RegistrationNotificationService.name);

  constructor(
    private readonly config: ConfigService,
    @Inject('REGISTRATION_SERVICE') private readonly registrations: ClientProxy,
    @Inject('CLASSES_SERVICE') private readonly classes: ClientProxy,
  ) {}

  claim(eventKey: string): Promise<boolean> {
    return sendRpc<boolean>(this.registrations, 'claim_notification', {
      eventKey,
    });
  }

  complete(eventKey: string) {
    return sendRpc(this.registrations, 'complete_notification', { eventKey });
  }

  fail(eventKey: string, error: string) {
    return sendRpc(this.registrations, 'fail_notification', {
      eventKey,
      error,
    });
  }

  async deliver(event: RegistrationEvent) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    const sender = this.config.get<string>('RESEND_FROM_EMAIL');
    if (!apiKey || !sender) {
      this.logger.debug(
        'Skipping registration notification because Resend is not configured',
      );
      return;
    }

    const baseUrl = userServiceUrl(this.config.get<string>('USER_SERVICE_URL'));
    const userResponse = await fetch(
      `${baseUrl}/users/${encodeURIComponent(event.payload.userId)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!userResponse.ok)
      throw new Error(`User lookup failed (${userResponse.status})`);
    const user = (await userResponse.json()) as UserRecord;
    if (!user.email) throw new Error('Registration recipient has no email');

    const cls = await sendRpc<ClassRecord | null>(this.classes, 'get_class', {
      id: event.payload.classId,
    });
    const className = cls?.name ?? `Class ${event.payload.classId}`;
    const subject = this.subject(event.eventType, className);
    const text = this.body(event, user, className, cls);
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: sender, to: [user.email], subject, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Resend rejected notification (${response.status})`);
  }

  private subject(eventType: string, className: string) {
    const label: Record<string, string> = {
      'registration.confirmed': 'Registration confirmed',
      'registration.waitlisted': 'Added to waitlist',
      'registration.promoted': 'Promoted from waitlist',
      'registration.canceled': 'Registration canceled',
      'class.canceled.registration': 'Class canceled',
    };
    return `[Move with Miya] ${label[eventType] ?? 'Registration update'}: ${className}`;
  }

  private body(
    event: RegistrationEvent,
    user: UserRecord,
    className: string,
    cls: ClassRecord | null,
  ) {
    const greeting = user.firstName ? `Hi ${user.firstName},` : 'Hi,';
    const when = cls?.startDate ? `\nStart: ${cls.startDate}` : '';
    const reason = event.payload.reason
      ? `\nReason: ${event.payload.reason}`
      : '';
    const messages: Record<string, string> = {
      'registration.confirmed': `Your registration for ${className} is confirmed.`,
      'registration.waitlisted': `You have been added to the waitlist for ${className}.`,
      'registration.promoted': `A seat opened and you are now registered for ${className}.`,
      'registration.canceled': `Your registration for ${className} has been canceled.`,
      'class.canceled.registration': `The class ${className} has been canceled.`,
    };
    return `${greeting}\n\n${messages[event.eventType] ?? 'Your registration has been updated.'}${when}${reason}`;
  }
}
