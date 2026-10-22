import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

/**
 * Upper bound for one RabbitMQ request/reply. Without it a request waits
 * forever when the consuming service is down, because the message simply
 * stays queued.
 */
export const RPC_TIMEOUT_MS = 10_000;

const CLIENT_ERRORS: Record<number, new (message?: string) => HttpException> = {
  400: BadRequestException,
  403: ForbiddenException,
  404: NotFoundException,
  409: ConflictException,
};

/**
 * Sends a request to a microservice and maps its RpcException payload
 * (`{ statusCode, message }`) onto the matching HTTP exception. Timeouts and
 * every other failure become a 503 with `unavailableMessage`, so internal
 * error details never reach the client.
 */
export async function sendRpc<T>(
  client: ClientProxy,
  cmd: string,
  payload: object,
  unavailableMessage = 'Service unavailable',
): Promise<T> {
  try {
    return await firstValueFrom(
      client.send<T>({ cmd }, payload).pipe(timeout(RPC_TIMEOUT_MS)),
    );
  } catch (error) {
    const data = (error ?? {}) as { statusCode?: unknown; message?: unknown };
    const ClientError =
      typeof data.statusCode === 'number'
        ? CLIENT_ERRORS[data.statusCode]
        : undefined;
    if (ClientError) {
      throw new ClientError(
        typeof data.message === 'string' ? data.message : undefined,
      );
    }
    throw new ServiceUnavailableException(unavailableMessage);
  }
}
