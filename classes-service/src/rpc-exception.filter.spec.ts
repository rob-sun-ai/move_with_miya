import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { lastValueFrom, type Observable } from 'rxjs';
import { Prisma } from './generated/prisma/client';
import { RpcErrorFilter } from './rpc-exception.filter';

// The generated client cannot load under ts-jest; stand in for its error.
jest.mock('./generated/prisma/client', () => {
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, { code }: { code: string }) {
      super(message);
      this.code = code;
    }
  }
  return { Prisma: { PrismaClientKnownRequestError } };
});

describe('RpcErrorFilter', () => {
  const filter = new RpcErrorFilter();
  const host = {} as never;

  function reply(exception: unknown) {
    return lastValueFrom(
      filter.catch(exception, host) as Observable<never>,
    ).catch((error: unknown) => error);
  }

  function prismaError(code: string) {
    return new Prisma.PrismaClientKnownRequestError('database error', {
      code,
      clientVersion: 'test',
    });
  }

  it.each([
    [new BadRequestException('capacity must be a positive integer'), 400],
    [new NotFoundException('Location 9 not found'), 404],
  ])('forwards %s with its status', async (exception, statusCode) => {
    await expect(reply(exception)).resolves.toEqual({
      statusCode,
      message: exception.message,
    });
  });

  it('reports a missing record as not found', async () => {
    await expect(reply(prismaError('P2025'))).resolves.toEqual({
      statusCode: 404,
      message: 'Record not found',
    });
  });

  it('reports a broken relation as a conflict', async () => {
    await expect(reply(prismaError('P2003'))).resolves.toEqual({
      statusCode: 409,
      message: 'A related record is missing or still references this record',
    });
  });

  it('keeps every other failure opaque', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(reply(new Error('password=secret'))).resolves.toEqual({
      status: 'error',
      message: 'Internal server error',
    });
    await expect(reply(prismaError('P1001'))).resolves.toEqual({
      status: 'error',
      message: 'Internal server error',
    });
    log.mockRestore();
  });
});
