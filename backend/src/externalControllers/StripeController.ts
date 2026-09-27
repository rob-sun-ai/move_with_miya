import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
  Param,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { AdminGuard } from '../common/guards/admin.guard';
import { StripeService } from './stripe.service';
import { CheckoutRateLimitGuard } from '../common/guards/checkout-rate-limit.guard';

@Controller('checkout')
export class StripeController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly config: ConfigService,
  ) {}

  private assertBrowserOrigin(req: Request) {
    const origin = req.headers.origin;
    if (!origin) return;
    let allowedOrigin: string | undefined;
    try {
      allowedOrigin = new URL(this.config.get<string>('PUBLIC_APP_URL') ?? '')
        .origin;
    } catch {
      allowedOrigin = undefined;
    }
    if (allowedOrigin !== origin) {
      throw new ForbiddenException('Invalid request origin');
    }
  }

  private requireUserId(req: Request): string {
    const userId = req.session?.userId;
    if (!userId) throw new UnauthorizedException('Not authenticated');
    return userId;
  }

  @Post('create-session')
  @UseGuards(CheckoutRateLimitGuard)
  createSession(@Req() req: Request, @Body() body?: { classId?: number }) {
    this.assertBrowserOrigin(req);
    const userId = this.requireUserId(req);
    if (!body || Object.keys(body).some((key) => key !== 'classId')) {
      throw new BadRequestException('Invalid checkout request');
    }
    const classId = Number(body.classId);
    if (!Number.isInteger(classId) || classId <= 0) {
      throw new BadRequestException('classId must be a positive integer');
    }
    return this.stripeService.createCheckoutSession(userId, classId);
  }

  @Post('webhook')
  async webhook(@Req() req: Request) {
    const signature = req.headers['stripe-signature'];
    const rawBody = req.body as unknown;
    if (typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Invalid Stripe webhook');
    }
    const event = this.stripeService.constructWebhookEvent(rawBody, signature);
    await this.stripeService.handleWebhook(event);
    return { received: true };
  }

  @Get('status')
  @UseGuards(CheckoutRateLimitGuard)
  status(@Req() req: Request, @Query('session_id') sessionId?: string) {
    const userId = this.requireUserId(req);
    if (!sessionId) throw new BadRequestException('session_id is required');
    return this.stripeService.statusForUser(sessionId, userId);
  }

  @UseGuards(AdminGuard)
  @Get('payments')
  payments(): Promise<unknown> {
    return this.stripeService.getAllPayments();
  }

  @UseGuards(AdminGuard, CheckoutRateLimitGuard)
  @Post('payments/:id/refund')
  refund(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body?: { percentage?: number },
  ) {
    this.assertBrowserOrigin(req);
    if (body && Object.keys(body).some((key) => key !== 'percentage')) {
      throw new BadRequestException('Invalid refund request');
    }
    return this.stripeService.refundPayment(id, body?.percentage);
  }
}
