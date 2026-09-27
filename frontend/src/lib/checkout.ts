import { api } from './api';

interface CheckoutResponse {
  url: string;
  paymentId: string;
}

export async function startCheckout(classId: number): Promise<void> {
  const result = await api<CheckoutResponse>('/api/checkout/create-session', {
    method: 'POST',
    body: JSON.stringify({ classId }),
  });
  if (!result.url || !/^https:\/\//.test(result.url)) {
    throw new Error('Checkout URL was invalid. Please try again.');
  }
  window.location.assign(result.url);
}
