import { describe, expect, it } from 'vitest';
import { formatCents, formatCost, fullName, locationLabel } from './format';

describe('format', () => {
  it.each([
    ['15', '$15.00'],
    ['12.5', '$12.50'],
    ['0', 'Free'],
    ['not a number', 'Free'],
  ])('formats a class cost of %s as %s', (cost, expected) => {
    expect(formatCost(cost)).toBe(expected);
  });

  it('formats Stripe minor units with the currency code', () => {
    expect(formatCents(2500, 'usd')).toBe('25.00 USD');
    expect(formatCents(1250, 'eur')).toBe('12.50 EUR');
  });

  it('labels a location by name, falling back to city and state', () => {
    const location = {
      id: 1,
      address: '1 Main St',
      city: 'Boston',
      state: 'MA',
      zipCode: '02110',
    };
    expect(locationLabel({ ...location, name: 'Studio One' })).toBe(
      'Studio One',
    );
    expect(locationLabel(location)).toBe('Boston, MA');
  });

  it('joins names without stray whitespace', () => {
    expect(fullName({ firstName: 'Miya', lastName: '' })).toBe('Miya');
  });
});
