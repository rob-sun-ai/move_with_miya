import { BadRequestException } from '@nestjs/common';

// Message payloads arrive as untyped JSON from RabbitMQ and the gateway
// forwards request bodies unchanged, so this service is the only place that
// validates them before they reach Prisma.

/** Largest value a PostgreSQL INTEGER column holds. */
const MAX_INTEGER = 2_147_483_647;
/** An ISO 8601 date-time with an explicit offset, so no timezone is guessed. */
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function asPayload(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequestException('Payload must be an object');
  }
  return data as Record<string, unknown>;
}

/** Rejects fields that are not editable, such as ids, timestamps, or relations. */
export function rejectUnknownFields(
  data: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new BadRequestException(`Unknown fields: ${unknown.join(', ')}`);
  }
}

/** Accepts a JSON number or a string of digits, never a boolean or array. */
export function parseInteger(value: unknown, field: string, min: number) {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isInteger(number) || number < min || number > MAX_INTEGER) {
    throw new BadRequestException(
      min > 0
        ? `${field} must be a positive integer`
        : `${field} must be a non-negative integer`,
    );
  }
  return number;
}

export function parseId(value: unknown, field = 'id'): number {
  return parseInteger(value, field, 1);
}

export function parseDate(value: unknown, field: string): Date {
  if (value == null || value === '') {
    throw new BadRequestException(`${field} is required`);
  }
  const date =
    typeof value === 'string' && ISO_DATE_TIME.test(value)
      ? new Date(value)
      : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    throw new BadRequestException(
      `${field} must be an ISO 8601 date-time with a timezone`,
    );
  }
  return date;
}

export function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value;
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean`);
  }
  return value;
}
