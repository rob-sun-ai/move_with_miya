import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { render } from '@/components/test-utils';
import CheckoutCancelPage from './page';

async function renderPage(params: { class_id?: string }) {
  render(await CheckoutCancelPage({ searchParams: Promise.resolve(params) }));
}

describe('CheckoutCancelPage', () => {
  it('explains that nothing was charged', async () => {
    await renderPage({});

    expect(
      screen.getByRole('heading', { name: 'Checkout canceled' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No registration was created/)).toBeInTheDocument();
  });

  it.each([
    [{ class_id: '7' }, '/classes/7'],
    [{ class_id: '7/../admin' }, '/classes/7%2F..%2Fadmin'],
    [{}, '/classes'],
  ])('links %o back to %s', async (params, href) => {
    await renderPage(params);

    expect(
      screen.getByRole('link', { name: 'Return to classes' }),
    ).toHaveAttribute('href', href);
  });
});
