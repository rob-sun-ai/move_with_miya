import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  NotFoundException,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { AdminGuard } from '../common/guards/admin.guard';
import { sendRpc } from '../common/rpc';
import { CancelClassDto } from './dto/cancel-class.dto';
import { StripeService } from './stripe.service';

interface Teacher {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  role: string;
}

interface ClassRecord {
  id: number;
  name: string;
  teacherIds: string[];
  capacity: number;
  cost: string;
  description: string;
  duration: number;
  startDate: string;
  endDate: string;
  status: string;
  locationId: number;
  location: Record<string, unknown>;
  isPrivate: boolean;
  waitlistEnabled: boolean;
  cancellationCutoffHours: number;
}

@Controller('classes')
export class ClassesController {
  constructor(
    @Inject('CLASSES_SERVICE') private readonly classesClient: ClientProxy,
    @Inject('REGISTRATION_SERVICE')
    private readonly registrationClient: ClientProxy,
    @Optional() private readonly stripeService?: StripeService,
  ) {}

  private rpcClasses<T = unknown>(cmd: string, payload: object) {
    return sendRpc<T>(
      this.classesClient,
      cmd,
      payload,
      'Class service unavailable',
    );
  }

  private rpcRegistrations<T = unknown>(cmd: string, payload: object) {
    return sendRpc<T>(
      this.registrationClient,
      cmd,
      payload,
      'Registration service unavailable',
    );
  }

  private async enrichClasses(classes: ClassRecord[]): Promise<ClassRecord[]> {
    if (classes.length === 0) return classes;

    const classIds = classes.map((c) => c.id);
    const [countRows, teacherIds] = await Promise.all([
      this.rpcRegistrations<{ classId: number; count: number }[]>(
        'get_registration_counts',
        { classIds },
      ),
      Promise.resolve([...new Set(classes.flatMap((c) => c.teacherIds ?? []))]),
    ]);

    const counts = new Map(countRows.map((r) => [r.classId, r.count]));

    let teachers: Teacher[] = [];
    if (teacherIds.length > 0) {
      const userServiceUrl =
        process.env.USER_SERVICE_URL || 'http://localhost:3003';
      const res = await fetch(
        `${userServiceUrl}/users/batch?ids=${encodeURIComponent(
          teacherIds.join(','),
        )}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        teachers = (await res.json()) as Teacher[];
      }
    }
    const teacherMap = new Map(teachers.map((t) => [t.id, t]));

    return classes.map((cls) => ({
      ...cls,
      registrationCount: counts.get(cls.id) ?? 0,
      teachers: (cls.teacherIds ?? [])
        .map((id) => teacherMap.get(id))
        .filter((t): t is Teacher => t !== undefined),
    }));
  }

  @Get()
  async findClasses() {
    const classes = await this.rpcClasses<ClassRecord[]>('get_classes', {});
    return this.enrichClasses(classes);
  }

  @Get('range')
  async findClassesInRange(
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ) {
    // A repeated query parameter arrives as an array. The classes service
    // validates the date format itself and replies 400 when it is wrong.
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new BadRequestException('from and to are required');
    }
    const classes = await this.rpcClasses<ClassRecord[]>(
      'get_classes_in_range',
      { from, to },
    );
    return this.enrichClasses(classes);
  }

  @Get(':id')
  async findClass(@Param('id', ParseIntPipe) id: number) {
    const cls = await this.rpcClasses<ClassRecord | null>('get_class', { id });
    if (!cls) return null;
    return (await this.enrichClasses([cls]))[0];
  }

  @UseGuards(AdminGuard)
  @Post()
  createClass(@Body() body: Record<string, unknown>) {
    return this.rpcClasses('create_class', body);
  }

  @UseGuards(AdminGuard)
  @Post(':id/cancel')
  async cancelClass(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: CancelClassDto,
  ) {
    const cls = await this.rpcClasses<ClassRecord | null>('get_class', { id });
    if (!cls) throw new NotFoundException(`Class ${id} not found`);

    const updated = await this.rpcClasses<ClassRecord>('update_class', {
      id,
      status: 'Canceled',
    });
    await this.rpcRegistrations('cancel_class_registrations', {
      classId: id,
      reason: body.reason?.trim() || 'Class canceled',
      source: 'class-cancellation',
    });
    if (this.stripeService) await this.stripeService.refundClassPayments(id);
    return updated;
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  async updateClass(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ) {
    const current = await this.rpcClasses<ClassRecord | null>('get_class', {
      id,
    });
    if (!current) throw new NotFoundException(`Class ${id} not found`);
    // Canceling also cancels registrations and refunds payments; routing it
    // through here would silently drop the rest of the edit.
    if (body.status === 'Canceled' && current.status !== 'Canceled') {
      throw new BadRequestException(
        'Use POST /classes/:id/cancel to cancel a class',
      );
    }

    if ('capacity' in body) {
      const nextCapacity = Number(body.capacity);
      const summary = await this.rpcRegistrations<{
        active: number;
      }>('get_class_lifecycle_summary', { classId: id });
      if (Number.isInteger(nextCapacity) && nextCapacity < summary.active) {
        throw new ConflictException(
          'Capacity cannot be lower than the number of active registrations',
        );
      }
    }

    const updated = await this.rpcClasses<ClassRecord>('update_class', {
      ...body,
      id,
    });
    const nextCapacity = Number(body.capacity ?? updated.capacity);
    if (
      nextCapacity > current.capacity ||
      (current.status === 'Canceled' && updated.status !== 'Canceled')
    ) {
      await this.rpcRegistrations('promote_waitlisted', {
        classId: id,
        capacity: nextCapacity,
      });
    }
    return updated;
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  async deleteClass(@Param('id', ParseIntPipe) id: number) {
    const summary = await this.rpcRegistrations<{
      total: number;
      active: number;
    }>('get_class_lifecycle_summary', { classId: id });
    if (summary.total > 0) {
      throw new ConflictException(
        'Classes with registration history must be canceled, not deleted',
      );
    }
    return this.rpcClasses('delete_class', { id });
  }
}
