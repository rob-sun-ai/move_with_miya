import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CheckoutRateLimitDecision,
  CheckoutRateLimitService,
} from '../checkout-rate-limit.service';

@Injectable()
export class CheckoutRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimitService: CheckoutRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    // Bucket by the matched route template, not the raw path, so variants
    // such as a trailing slash cannot open a fresh bucket.
    const routePath = (request as { route?: { path?: unknown } }).route?.path;
    const template = typeof routePath === 'string' ? routePath : 'checkout';
    const isRefund = template.endsWith('/refund');
    // The success page polls this read-only, member-scoped lookup while it
    // waits for the webhook, so it gets its own generous per-IP bucket.
    const isStatus = template.endsWith('/status');
    // One refund bucket per admin, whichever payment is being refunded.
    const route = isRefund ? '/checkout/payments/refund' : template;
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const userId = request.session?.userId;

    let ipDecision: CheckoutRateLimitDecision;
    let userDecision: CheckoutRateLimitDecision | undefined;
    try {
      [ipDecision, userDecision] = await Promise.all([
        isRefund
          ? this.rateLimitService.consumeRefundIp(route, ip)
          : isStatus
            ? this.rateLimitService.consumeStatusIp(route, ip)
            : this.rateLimitService.consumeIp(route, ip),
        userId && !isStatus
          ? this.rateLimitService.consumeUser(route, userId)
          : Promise.resolve(undefined),
      ]);
    } catch {
      throw new ServiceUnavailableException(
        'Payment service is temporarily unavailable',
      );
    }

    this.rateLimitService.applyHeaders(response, ipDecision, 'IP');
    if (userDecision) {
      this.rateLimitService.applyHeaders(response, userDecision, 'User');
    }
    if (!ipDecision.allowed || userDecision?.allowed === false) {
      throw new HttpException(
        'Too many payment requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
