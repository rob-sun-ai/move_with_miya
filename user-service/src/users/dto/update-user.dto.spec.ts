import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateUserDto } from './update-user.dto';

// Mirrors the global pipe in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

function validate(body: Record<string, unknown>) {
  return pipe.transform(body, { type: 'body', metatype: UpdateUserDto });
}

describe('UpdateUserDto', () => {
  it('accepts the profile form, including cleared optional fields', async () => {
    const body = {
      firstName: 'Move',
      lastName: 'Miya',
      preferredName: null,
      phoneNumber: '+1 555 0100',
      yogaExperience: null,
    };
    await expect(validate(body)).resolves.toEqual(body);
  });

  it.each([
    { role: 'ADMIN' },
    { banned: false },
    { email: 'a@b.test' },
    { avatarUrl: 'https://tracker.test/pixel.gif' },
  ])('rejects self-service changes to %o', async (body) => {
    await expect(validate(body)).rejects.toThrow(BadRequestException);
  });

  it.each([
    [{ firstName: null }],
    [{ firstName: '' }],
    [{ lastName: null }],
    [{ firstName: 'a'.repeat(101) }],
    [{ yogaExperience: 'a'.repeat(2001) }],
  ])('rejects %o', async (body) => {
    await expect(validate(body)).rejects.toThrow(BadRequestException);
  });
});
