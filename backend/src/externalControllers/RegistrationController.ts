import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClientProxy } from '@nestjs/microservices';
import { AdminGuard } from '../common/guards/admin.guard';
import { StaffGuard } from '../common/guards/staff.guard';
import { sendRpc } from '../common/rpc';
import {
  fetchActiveUser,
  fetchUserSummaries,
  type UserSummary,
  userServiceUrl,
} from '../common/user-verification';
import { StripeService } from './stripe.service';
import { CancelRegistrationDto } from './dto/cancel-registration.dto';
import { UpdateRegistrationDto } from './dto/update-registration.dto';

interface Registration {
  id: number;
  userId: string;
  classId: number;
  status: string;
  registeredAt: string;
  user?: UserSummary | null;
  class?: {
    id: number;
    name: string;
    startDate: string;
    endDate: string;
  } | null;
}

interface ClassSummary {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
}

@Controller('registration')
export class RegistrationController {
  private readonly logger = new Logger(RegistrationController.name);

  constructor(
    @Inject('REGISTRATION_SERVICE')
    private readonly registrationClient: ClientProxy,
    @Inject('CLASSES_SERVICE')
    private readonly classesClient: ClientProxy,
    @Optional() private readonly stripeService?: StripeService,
  ) {}

  /**
   * Refund percentage owed to a member cancelling now: the tier with the
   * largest threshold that is still ahead of the class start. Undefined once
   * the cancellation cutoff has passed.
   */
  private refundPercentageForMemberCancellation(
    startDate: string,
    cls: {
      cancellationCutoffHours?: number;
      refundPolicy?: Array<{ hoursBeforeStart: number; percentage: number }>;
    },
  ) {
    const cutoffHours = cls.cancellationCutoffHours ?? 24;
    const startTime = new Date(startDate).getTime();
    const cutoff = startTime - cutoffHours * 3_600_000;
    if (Date.now() >= cutoff) return undefined;
    const hoursUntilStart = (startTime - Date.now()) / 3_600_000;
    const tiers = (
      cls.refundPolicy ?? [{ hoursBeforeStart: cutoffHours, percentage: 100 }]
    ).filter(
      (tier) =>
        Number.isInteger(tier.hoursBeforeStart) &&
        Number.isInteger(tier.percentage) &&
        tier.hoursBeforeStart <= hoursUntilStart,
    );
    if (tiers.length === 0) return 0;
    return tiers.sort((a, b) => b.hoursBeforeStart - a.hoursBeforeStart)[0]
      .percentage;
  }

  /**
   * The cancellation has already committed and queued the refund. A failed
   * Stripe call is retried by StripeService's refund sweep, so it must not
   * fail the request.
   */
  private async refundAfterCancellation(paymentId: string) {
    try {
      await this.stripeService?.refundPayment(paymentId);
    } catch (error) {
      this.logger.warn(
        `Refund for payment ${paymentId.slice(0, 8)} will be retried: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private rpc<T = unknown>(cmd: string, payload: object) {
    return sendRpc<T>(
      this.registrationClient,
      cmd,
      payload,
      'Registration service unavailable',
    );
  }

  private getClass(classId: number) {
    return sendRpc<{
      id: number;
      capacity?: number;
      startDate?: string;
      endDate?: string;
      status?: string;
      isPrivate?: boolean;
      cost?: string | number;
      waitlistEnabled?: boolean;
      cancellationCutoffHours?: number;
      refundPolicy?: Array<{
        hoursBeforeStart: number;
        percentage: number;
      }>;
    } | null>(
      this.classesClient,
      'get_class',
      { id: classId },
      'Class service unavailable',
    );
  }

  /**
   * Attaches `class` (and, for staff views, `user`) to each registration.
   * Both are best effort and fall back to null.
   */
  private async enrichRegistrations(
    registrations: Registration[],
    { withUsers = true } = {},
  ): Promise<Registration[]> {
    const userIds = withUsers
      ? [...new Set(registrations.map((r) => r.userId).filter(Boolean))]
      : [];

    const [users, classes] = await Promise.all([
      fetchUserSummaries(userServiceUrl(), userIds),
      sendRpc<ClassSummary[]>(this.classesClient, 'get_classes', {}).catch(
        (): ClassSummary[] => [],
      ),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const classMap = new Map(classes.map((cls) => [cls.id, cls]));
    return registrations.map((registration) => ({
      ...registration,
      ...(withUsers && { user: userMap.get(registration.userId) ?? null }),
      class: classMap.get(registration.classId) ?? null,
    }));
  }

  @UseGuards(StaffGuard)
  @Get('class/:classId')
  async findRegistrations(@Param('classId', ParseIntPipe) classId: number) {
    const registrations = await this.rpc<Registration[]>('get_registrations', {
      classId,
    });
    return this.enrichRegistrations(registrations);
  }

  @UseGuards(AdminGuard)
  @Get()
  async findAllRegistrations() {
    const registrations = await this.rpc<Registration[]>(
      'get_all_registrations',
      {},
    );
    return this.enrichRegistrations(registrations);
  }

  @Get('me')
  async getMyRegistrations(@Req() req: Request) {
    const userId = req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    const registrations = await this.rpc<Registration[]>(
      'get_registrations_by_user',
      { userId },
    );
    // Members see their own registrations with class details, but no
    // user profiles.
    return this.enrichRegistrations(registrations, { withUsers: false });
  }

  @UseGuards(AdminGuard)
  @Get(':id')
  findRegistration(@Param('id', ParseIntPipe) id: number) {
    return this.rpc<Registration>('get_registration', { id });
  }

  @Post('class/:classId/user/:userId')
  async createRegistration(
    @Req() req: Request,
    @Param('classId', ParseIntPipe) classId: number,
    @Param('userId') userId: string,
  ) {
    if (!req.session?.userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    if (req.session.userId !== userId) {
      throw new ForbiddenException(
        'You can only register yourself for a class',
      );
    }
    const cls = await this.assertClassOpenForRegistration(classId, userId);
    return this.rpc<Registration>('create_registration', {
      classId,
      userId,
      capacity: cls.capacity,
      waitlistEnabled: cls.waitlistEnabled,
    });
  }

  private async assertClassOpenForRegistration(
    classId: number,
    userId: string,
  ): Promise<{
    capacity: number;
    waitlistEnabled: boolean;
    classStartAt?: string;
    cancellationCutoffHours: number;
  }> {
    const cls = await this.getClass(classId);
    if (!cls) {
      throw new NotFoundException(`Class ${classId} not found`);
    }
    if (cls.status === 'Canceled' || cls.status === 'Completed') {
      throw new ForbiddenException('This class is not open for registration');
    }
    if (cls.endDate && new Date(cls.endDate).getTime() <= Date.now()) {
      throw new ForbiddenException('This class has already ended');
    }
    const cost = Number(cls.cost ?? 0);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new ServiceUnavailableException('Class price is invalid');
    }
    if (cost > 0) {
      throw new ConflictException('Paid classes require Stripe Checkout');
    }
    const capacity = cls.capacity;
    if (
      capacity === undefined ||
      !Number.isInteger(capacity) ||
      capacity <= 0
    ) {
      throw new ServiceUnavailableException('Class capacity is invalid');
    }

    const user = await fetchActiveUser(userServiceUrl(), userId);
    if (cls.isPrivate && !user.yogaExperience?.trim()) {
      throw new ForbiddenException(
        'Yoga experience is required for this class',
      );
    }

    return {
      capacity,
      waitlistEnabled: cls.waitlistEnabled ?? true,
      classStartAt: cls.startDate,
      cancellationCutoffHours: cls.cancellationCutoffHours ?? 24,
    };
  }

  @Get('class/:classId/me')
  async getMyRegistration(
    @Req() req: Request,
    @Param('classId', ParseIntPipe) classId: number,
  ) {
    const userId = req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    return this.rpc<Registration>('get_registration_by_class_and_user', {
      classId,
      userId,
    });
  }

  @Delete('class/:classId/me')
  async cancelMyRegistration(
    @Req() req: Request,
    @Param('classId', ParseIntPipe) classId: number,
  ) {
    const userId = req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    const cls = await this.getClass(classId);
    if (!cls || cls.capacity === undefined || !cls.startDate) {
      throw new NotFoundException(`Class ${classId} not found`);
    }
    const result = await this.rpc<Registration & { refundPaymentId?: string }>(
      'cancel_registration_by_class_and_user',
      {
        classId,
        userId,
        capacity: cls.capacity,
        classStartAt: cls.startDate,
        cancellationCutoffHours: cls.cancellationCutoffHours ?? 24,
        source: 'member',
        refundPercentage: this.refundPercentageForMemberCancellation(
          cls.startDate,
          cls,
        ),
      },
    );
    if (result.refundPaymentId) {
      await this.refundAfterCancellation(result.refundPaymentId);
    }
    return result;
  }

  @UseGuards(AdminGuard)
  @Post(':id/cancel')
  async cancelRegistration(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CancelRegistrationDto,
  ) {
    const registration = await this.rpc<Registration>('get_registration', {
      id,
    });
    const cls = await this.getClass(registration.classId);
    if (!cls || cls.capacity === undefined) {
      throw new NotFoundException(`Class ${registration.classId} not found`);
    }
    const result = await this.rpc<Registration & { refundPaymentId?: string }>(
      'cancel_registration',
      {
        id,
        capacity: cls.capacity,
        classStartAt: cls.startDate,
        cancellationCutoffHours: cls.cancellationCutoffHours ?? 24,
        source: 'admin',
        reason: body.reason?.trim() || 'Admin cancellation',
        refundPercentage: body.refundPercentage ?? 100,
      },
    );
    if (result.refundPaymentId) {
      await this.refundAfterCancellation(result.refundPaymentId);
    }
    return result;
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  updateRegistration(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateRegistrationDto,
  ) {
    return this.rpc<Registration>('update_registration', { ...body, id });
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  cancelRegistrationLegacy(@Param('id', ParseIntPipe) id: number) {
    return this.cancelRegistration(id, {});
  }
}
