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
    const route = request.path || 'checkout';
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const userId = request.session?.userId;
    const isRefund = route.endsWith('/refund');

    let ipDecision: CheckoutRateLimitDecision;
    let userDecision: CheckoutRateLimitDecision | undefined;
    try {
      [ipDecision, userDecision] = await Promise.all([
        isRefund
          ? this.rateLimitService.consumeRefundIp(route, ip)
          : this.rateLimitService.consumeIp(route, ip),
        userId
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
