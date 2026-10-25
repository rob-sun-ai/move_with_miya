import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCheckout } from './checkout';

describe('startCheckout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function respond(body: unknown, status = 200) {
    return vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  it('creates a session for the class and redirects to Stripe', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const fetchMock = respond({
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      paymentId: 'payment-1',
    });

    await startCheckout(7);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/checkout/create-session',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ classId: 7 }),
      }),
    );
    expect(assign).toHaveBeenCalledWith(
      'https://checkout.stripe.com/c/pay/cs_1',
    );
  });

  it.each([
    ['a missing URL', {}],
    ['an insecure URL', { url: 'http://checkout.test' }],
    ['a script URL', { url: 'javascript:alert(1)' }],
  ])('refuses to redirect to %s', async (_label, body) => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    respond(body);

    await expect(startCheckout(7)).rejects.toThrow(
      'Checkout URL was invalid. Please try again.',
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('surfaces API errors', async () => {
    respond({ message: 'Class is full' }, 409);

    await expect(startCheckout(7)).rejects.toThrow('Class is full');
  });
});
