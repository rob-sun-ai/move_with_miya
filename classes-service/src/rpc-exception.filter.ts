import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseRpcExceptionFilter } from '@nestjs/microservices';
import { throwError } from 'rxjs';
import { Prisma } from './generated/prisma/client';

/**
 * Replies to failed requests with `{ statusCode, message }`, the shape the
 * other services use, instead of Nest's generic "Internal server error".
 * Validation errors and missing or still-referenced records are the caller's
 * to handle; anything else stays an opaque internal error.
 */
@Catch()
export class RpcErrorFilter extends BaseRpcExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (exception instanceof HttpException) {
      return this.reply(exception.getStatus(), exception.message);
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        return this.reply(404, 'Record not found');
      }
      if (exception.code === 'P2003') {
        return this.reply(
          409,
          'A related record is missing or still references this record',
        );
      }
    }
    return super.catch(exception, host);
  }

  private reply(statusCode: number, message: string) {
    return throwError(() => ({ statusCode, message }));
  }
}
