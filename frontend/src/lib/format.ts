import type { Location } from './types';

/** Formats a class cost (a decimal dollar string) for display. */
export function formatCost(cost: string): string {
  const amount = Number(cost);
  if (Number.isNaN(amount) || amount === 0) return 'Free';
  return `$${amount.toFixed(2)}`;
}

/** Formats a Stripe amount in minor units, e.g. 2500 usd -> "25.00 USD". */
export function formatCents(amountCents: number, currency: string): string {
  return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export function locationLabel(location: Location): string {
  return location.name ?? `${location.city}, ${location.state}`;
}

export function fullName(person: {
  firstName: string;
  lastName: string;
}): string {
  return `${person.firstName} ${person.lastName}`.trim();
}
