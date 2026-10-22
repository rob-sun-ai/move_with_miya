import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { LocationController } from './LocationController';

describe('LocationController', () => {
  let controller: LocationController;
  let client: { send: jest.Mock };

  beforeEach(() => {
    client = { send: jest.fn().mockReturnValue(of('result')) };
    controller = new LocationController(client as never);
  });

  it('forwards public location reads', async () => {
    await expect(controller.findLocations()).resolves.toBe('result');
    await expect(controller.findLocation(3)).resolves.toBe('result');
    expect(client.send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'get_locations' },
      {},
    );
    expect(client.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'get_location' },
      { id: 3 },
    );
  });

  it('forwards admin location mutations', async () => {
    await controller.createLocation({ name: 'Studio' });
    await controller.updateLocation(3, { city: 'Boston' });
    await controller.deleteLocation(3);
    expect(client.send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'create_location' },
      { name: 'Studio' },
    );
    expect(client.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'update_location' },
      { city: 'Boston', id: 3 },
    );
    expect(client.send).toHaveBeenNthCalledWith(
      3,
      { cmd: 'delete_location' },
      { id: 3 },
    );
  });

  it('maps classes-service errors to their HTTP status', async () => {
    client.send.mockReturnValueOnce(
      throwError(() => ({ statusCode: 404, message: 'Location 9 not found' })),
    );
    await expect(controller.findLocation(9)).rejects.toEqual(
      new NotFoundException('Location 9 not found'),
    );

    client.send.mockReturnValueOnce(
      throwError(() => ({ statusCode: 400, message: 'Unknown fields: id2' })),
    );
    await expect(controller.updateLocation(9, { id2: 1 })).rejects.toEqual(
      new BadRequestException('Unknown fields: id2'),
    );

    const stillUsed =
      'A related record is missing or still references this record';
    client.send.mockReturnValueOnce(
      throwError(() => ({ statusCode: 409, message: stillUsed })),
    );
    await expect(controller.deleteLocation(9)).rejects.toEqual(
      new ConflictException(stillUsed),
    );
  });
});
