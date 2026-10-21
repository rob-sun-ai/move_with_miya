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
    const path = request.path || 'checkout';
    const isRefund = path.endsWith('/refund');
    // The success page polls this read-only, member-scoped lookup while it
    // waits for the webhook, so it gets its own generous per-IP bucket.
    const isStatus = path.endsWith('/status');
    // Refund paths contain the payment id; limit per admin, not per payment.
    const route = isRefund ? '/checkout/payments/refund' : path;
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
