import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { RegistrationService } from './registration.service';

@Controller()
export class RegistrationController {
  constructor(private readonly registrationService: RegistrationService) {}

  @MessagePattern({ cmd: 'get_registrations' })
  findRegistrations(data: { classId: number }) {
    return this.registrationService.findRegistrations(data.classId);
  }

  @MessagePattern({ cmd: 'get_registration' })
  findRegistration(data: { id: number }) {
    return this.registrationService.findRegistration(data.id);
  }

  @MessagePattern({ cmd: 'create_registration' })
  createRegistration(
    data: {
      classId: number;
      userId: string;
      capacity: number;
      waitlistEnabled?: boolean;
      source?: string;
    } & Record<string, unknown>,
  ) {
    return this.registrationService.createRegistration(
      data.classId,
      data.userId,
      data.capacity,
      { waitlistEnabled: data.waitlistEnabled, source: data.source },
    );
  }

  @MessagePattern({ cmd: 'get_registrations_by_user' })
  findRegistrationsByUser(data: { userId: string }) {
    return this.registrationService.findRegistrationsByUser(data.userId);
  }

  @MessagePattern({ cmd: 'get_all_registrations' })
  findAllRegistrations() {
    return this.registrationService.findAllRegistrations();
  }

  @MessagePattern({ cmd: 'get_registration_counts' })
  getRegistrationCounts(data: { classIds: number[] }) {
    return this.registrationService.getRegistrationCounts(data.classIds);
  }

  @MessagePattern({ cmd: 'get_registration_by_class_and_user' })
  findRegistrationByClassAndUser(data: { classId: number; userId: string }) {
    return this.registrationService.findRegistrationByClassAndUser(
      data.classId,
      data.userId,
    );
  }

  @MessagePattern({ cmd: 'cancel_registration_by_class_and_user' })
  cancelRegistrationByClassAndUser(data: {
    classId: number;
    userId: string;
    capacity: number;
    classStartAt?: string;
    cancellationCutoffHours?: number;
    source?: string;
    reason?: string;
  }) {
    return this.registrationService.cancelRegistrationByClassAndUser(
      data.classId,
      data.userId,
      data,
    );
  }

  @MessagePattern({ cmd: 'delete_registration_by_class_and_user' })
  deleteRegistrationByClassAndUser() {
    return this.registrationService.deleteRegistrationByClassAndUser();
  }

  @MessagePattern({ cmd: 'cancel_registration' })
  cancelRegistration(data: {
    id: number;
    capacity: number;
    classStartAt?: string;
    cancellationCutoffHours?: number;
    source?: string;
    reason?: string;
  }) {
    return this.registrationService.cancelRegistration(data.id, data);
  }

  @MessagePattern({ cmd: 'cancel_class_registrations' })
  cancelClassRegistrations(data: {
    classId: number;
    reason?: string;
    source?: string;
  }) {
    return this.registrationService.cancelClassRegistrations(
      data.classId,
      data.reason,
      data.source,
    );
  }

  @MessagePattern({ cmd: 'promote_waitlisted' })
  promoteWaitlisted(data: { classId: number; capacity: number }) {
    return this.registrationService.promoteWaitlisted(
      data.classId,
      data.capacity,
    );
  }

  @MessagePattern({ cmd: 'get_class_lifecycle_summary' })
  getClassLifecycleSummary(data: { classId: number }) {
    return this.registrationService.getClassLifecycleSummary(data.classId);
  }

  @MessagePattern({ cmd: 'claim_notification' })
  claimNotification(data: { eventKey: string }) {
    return this.registrationService.claimNotification(data.eventKey);
  }

  @MessagePattern({ cmd: 'complete_notification' })
  completeNotification(data: { eventKey: string }) {
    return this.registrationService.completeNotification(data.eventKey);
  }

  @MessagePattern({ cmd: 'fail_notification' })
  failNotification(data: { eventKey: string; error: string }) {
    return this.registrationService.failNotification(data.eventKey, data.error);
  }

  @MessagePattern({ cmd: 'update_registration' })
  updateRegistration(data: { id: number } & Record<string, unknown>) {
    const { id, ...rest } = data;
    return this.registrationService.updateRegistration(id, rest);
  }

  @MessagePattern({ cmd: 'delete_registration' })
  deleteRegistration(data: { id: number }) {
    return this.registrationService.deleteRegistration(data.id);
  }

  @MessagePattern({ cmd: 'delete_registrations' })
  deleteClassRegistrations(data: { classId: number }) {
    return this.registrationService.deleteClassRegistrations(data.classId);
  }

  @MessagePattern({ cmd: 'create_contact_submission' })
  createContactSubmission(data: {
    name: string;
    email: string;
    subject: string;
    message: string;
  }) {
    return this.registrationService.createContactSubmission(data);
  }

  @MessagePattern({ cmd: 'get_contact_submissions' })
  getContactSubmissions(data: { take?: number; skip?: number }) {
    return this.registrationService.getContactSubmissions(data.take, data.skip);
  }

  @MessagePattern({ cmd: 'mark_contact_submission_read' })
  markContactSubmissionRead(data: { id: number; read: boolean }) {
    return this.registrationService.markContactSubmissionRead(
      data.id,
      data.read,
    );
  }
}
