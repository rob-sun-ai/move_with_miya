import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NEVER, of, throwError } from 'rxjs';
import { RPC_TIMEOUT_MS, sendRpc } from './rpc';

describe('sendRpc', () => {
  const clientReturning = (reply: unknown) =>
    ({ send: jest.fn().mockReturnValue(reply) }) as never;

  afterEach(() => jest.useRealTimers());

  it('sends the command and resolves with the reply', async () => {
    const client = { send: jest.fn().mockReturnValue(of({ id: 1 })) };

    await expect(
      sendRpc(client as never, 'get_thing', { id: 1 }),
    ).resolves.toEqual({ id: 1 });
    expect(client.send).toHaveBeenCalledWith({ cmd: 'get_thing' }, { id: 1 });
  });

  it.each([
    [400, BadRequestException],
    [403, ForbiddenException],
    [404, NotFoundException],
    [409, ConflictException],
  ])('maps RpcException status %p to %p', async (statusCode, type) => {
    const client = clientReturning(
      throwError(() => ({ statusCode, message: 'from service' })),
    );

    await expect(sendRpc(client, 'cmd', {})).rejects.toEqual(
      new type('from service'),
    );
  });

  it('keeps the default message for a client error without one', async () => {
    const client = clientReturning(throwError(() => ({ statusCode: 404 })));

    await expect(sendRpc(client, 'cmd', {})).rejects.toEqual(
      new NotFoundException(),
    );
  });

  it.each([
    ['a server error', { statusCode: 500, message: 'db constraint failed' }],
    ['a remote crash', { status: 'error', message: 'Internal server error' }],
    ['a transport error', new Error('connection closed')],
    ['nothing', undefined],
  ])('hides %s behind a 503', async (_label, error) => {
    const client = clientReturning(throwError(() => error));

    await expect(
      sendRpc(client, 'cmd', {}, 'Things unavailable'),
    ).rejects.toEqual(new ServiceUnavailableException('Things unavailable'));
  });

  it('gives up when the service never replies', async () => {
    jest.useFakeTimers();
    const result = sendRpc(clientReturning(NEVER), 'cmd', {});
    const assertion = expect(result).rejects.toEqual(
      new ServiceUnavailableException('Service unavailable'),
    );

    await jest.advanceTimersByTimeAsync(RPC_TIMEOUT_MS);
    await assertion;
  });
});
