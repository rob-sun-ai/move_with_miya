import {
  Body,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom } from 'rxjs';
import { AdminGuard } from '../common/guards/admin.guard';
import { StaffGuard } from '../common/guards/staff.guard';
import { sendRpc } from '../common/rpc';
import { UpdateRegistrationDto } from './dto/update-registration.dto';

interface Registration {
  id: number;
  userId: string;
  classId: number;
  status: string;
  registeredAt: string;
  user?: Record<string, unknown> | null;
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
  constructor(
    @Inject('REGISTRATION_SERVICE')
    private readonly registrationClient: ClientProxy,
    @Inject('CLASSES_SERVICE')
    private readonly classesClient: ClientProxy,
  ) {}

  private rpc<T = unknown>(cmd: string, payload: object) {
    return sendRpc<T>(
      this.registrationClient,
      cmd,
      payload,
      'Registration service unavailable',
    );
  }

  private rpcClasses<T = unknown>(cmd: string, payload: object) {
    return sendRpc<T>(
      this.classesClient,
      cmd,
      payload,
      'Class service unavailable',
    );
  }

  private async getClass(classId: number) {
    try {
      return await lastValueFrom<{
        id: number;
        capacity?: number;
        startDate?: string;
        endDate?: string;
        status?: string;
        isPrivate?: boolean;
        waitlistEnabled?: boolean;
        cancellationCutoffHours?: number;
      } | null>(this.classesClient.send({ cmd: 'get_class' }, { id: classId }));
    } catch {
      throw new ServiceUnavailableException('Class service unavailable');
    }
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
    const userServiceUrl =
      process.env.USER_SERVICE_URL || 'http://localhost:3003';

    const [users, classes] = await Promise.all([
      userIds.length === 0
        ? Promise.resolve([] as Record<string, unknown>[])
        : fetch(
            `${userServiceUrl}/users/batch?ids=${encodeURIComponent(
              userIds.join(','),
            )}`,
            { cache: 'no-store' },
          ).then(async (res) =>
            res.ok ? ((await res.json()) as Record<string, unknown>[]) : [],
          ),
      this.rpcClasses<ClassSummary[]>('get_classes', {}).catch(
        (): ClassSummary[] => [],
      ),
    ]);

    const userMap = new Map(users.map((u) => [String(u.id), u]));
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
    const capacity = cls.capacity;
    if (
      capacity === undefined ||
      !Number.isInteger(capacity) ||
      capacity <= 0
    ) {
      throw new ServiceUnavailableException('Class capacity is invalid');
    }

    const userServiceUrl =
      process.env.USER_SERVICE_URL || 'http://localhost:3003';
    let userResponse: Response;
    try {
      userResponse = await fetch(`${userServiceUrl}/users/${userId}`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ServiceUnavailableException('User service unreachable');
    }
    if (userResponse.status >= 500) {
      throw new ServiceUnavailableException('User service error');
    }
    if (!userResponse.ok) {
      throw new UnauthorizedException('Unable to verify user');
    }
    const user = (await userResponse.json()) as {
      banned?: boolean;
      yogaExperience?: string | null;
    };
    if (user.banned) {
      throw new ForbiddenException('User is banned');
    }
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
    return this.rpc<Registration>('cancel_registration_by_class_and_user', {
      classId,
      userId,
      capacity: cls.capacity,
      classStartAt: cls.startDate,
      cancellationCutoffHours: cls.cancellationCutoffHours ?? 24,
      source: 'member',
    });
  }

  @UseGuards(AdminGuard)
  @Post(':id/cancel')
  async cancelRegistration(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { reason?: string },
  ) {
    const registration = await this.rpc<Registration>('get_registration', {
      id,
    });
    const cls = await this.getClass(registration.classId);
    if (!cls || cls.capacity === undefined) {
      throw new NotFoundException(`Class ${registration.classId} not found`);
    }
    return this.rpc<Registration>('cancel_registration', {
      id,
      capacity: cls.capacity,
      classStartAt: cls.startDate,
      cancellationCutoffHours: cls.cancellationCutoffHours ?? 24,
      source: 'admin',
      reason: body.reason?.trim() || 'Admin cancellation',
    });
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

  @UseGuards(AdminGuard)
  @Post('class/:classId/cancel')
  cancelClassRegistrations(
    @Param('classId', ParseIntPipe) classId: number,
    @Body() body: { reason?: string },
  ) {
    return this.rpc('cancel_class_registrations', {
      classId,
      reason: body.reason?.trim() || 'Class canceled',
      source: 'class-cancellation',
    });
  }
}
