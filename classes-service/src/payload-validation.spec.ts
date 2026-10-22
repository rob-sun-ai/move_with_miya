import { BadRequestException } from '@nestjs/common';
import {
  asPayload,
  parseBoolean,
  parseDate,
  parseId,
  parseInteger,
  parseRequiredString,
  rejectUnknownFields,
} from './payload-validation';

describe('payload validation', () => {
  it.each([null, undefined, 'text', 3, [1]])('rejects a %p payload', (data) => {
    expect(() => asPayload(data)).toThrow('Payload must be an object');
  });

  it('accepts an object payload', () => {
    expect(asPayload({ id: 1 })).toEqual({ id: 1 });
  });

  it('names every field that is not allowed', () => {
    expect(() =>
      rejectUnknownFields({ name: 'a', createdAt: 'x', location: {} }, [
        'name',
      ]),
    ).toThrow('Unknown fields: createdAt, location');
    expect(() => rejectUnknownFields({ name: 'a' }, ['name'])).not.toThrow();
  });

  it.each([
    [5, 5],
    ['12', 12],
    [' 7 ', 7],
  ])('parses the integer %p', (value, expected) => {
    expect(parseInteger(value, 'capacity', 1)).toBe(expected);
  });

  it.each([true, [5], '5.5', 5.5, '', '-1', 0, 2_147_483_648, null, {}])(
    'rejects %p as a positive integer',
    (value) => {
      expect(() => parseInteger(value, 'capacity', 1)).toThrow(
        'capacity must be a positive integer',
      );
    },
  );

  it('allows zero for non-negative integers', () => {
    expect(parseInteger(0, 'cutoff', 0)).toBe(0);
    expect(() => parseInteger(-1, 'cutoff', 0)).toThrow(
      'cutoff must be a non-negative integer',
    );
  });

  it('validates ids', () => {
    expect(parseId(3)).toBe(3);
    expect(() => parseId(undefined)).toThrow('id must be a positive integer');
    expect(() => parseId('abc', 'locationId')).toThrow(
      'locationId must be a positive integer',
    );
  });

  it.each([
    '2026-09-01T10:00:00.000Z',
    '2026-09-01T10:00Z',
    '2026-09-01T06:00:00-04:00',
  ])('parses the zoned date-time %p', (value) => {
    expect(parseDate(value, 'startDate')).toEqual(new Date(value));
  });

  it.each([
    // No timezone: the server's local zone would be guessed.
    '2026-09-01T10:00:00',
    '2026-09-01',
    'Sep 1 2026 10:00',
    '2026-13-01T10:00:00Z',
    1_788_000_000_000,
    true,
  ])('rejects the date %p', (value) => {
    expect(() => parseDate(value, 'startDate')).toThrow(
      'startDate must be an ISO 8601 date-time with a timezone',
    );
  });

  it('reports a missing date as required', () => {
    expect(() => parseDate(undefined, 'from')).toThrow('from is required');
  });

  it('requires non-empty strings and real booleans', () => {
    expect(parseRequiredString('Flow', 'name')).toBe('Flow');
    expect(() => parseRequiredString('  ', 'name')).toThrow(
      BadRequestException,
    );
    expect(() => parseRequiredString(5, 'name')).toThrow(BadRequestException);
    expect(parseBoolean(false, 'isPrivate')).toBe(false);
    expect(() => parseBoolean('true', 'isPrivate')).toThrow(
      'isPrivate must be a boolean',
    );
  });
});
