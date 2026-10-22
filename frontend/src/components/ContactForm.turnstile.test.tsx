import { useEffect } from 'react';
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';

// Stands in for next/script: onReady fires once the script has loaded.
const scriptLoaded = vi.hoisted(() => ({ current: false }));
vi.mock('next/script', () => ({
  default: function Script({ onReady }: { onReady?: () => void }) {
    useEffect(() => {
      if (!scriptLoaded.current) {
        scriptLoaded.current = true;
        onReady?.();
      }
    }, [onReady]);
    return null;
  },
}));

const turnstile = {
  render: vi.fn(() => 'widget-1'),
  reset: vi.fn(),
  remove: vi.fn(),
};

async function loadContactForm() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key');
  return (await import('./ContactForm')).default;
}

describe('ContactForm Turnstile widget', () => {
  beforeEach(() => {
    vi.stubGlobal('turnstile', turnstile);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'challenge-token' })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    turnstile.render.mockClear();
    turnstile.remove.mockClear();
  });

  it('renders the widget on every visit and removes it on leaving', async () => {
    const ContactForm = await loadContactForm();

    const first = render(<ContactForm />);
    expect(
      screen.queryByText('Contact verification is not configured.'),
    ).toBeNull();
    expect(turnstile.render).toHaveBeenCalledTimes(1);
    expect(turnstile.render).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        sitekey: 'site-key',
        action: 'contact',
        'response-field-name': 'turnstileToken',
      }),
    );
    first.unmount();
    expect(turnstile.remove).toHaveBeenCalledWith('widget-1');

    // A client-side navigation back mounts the form again with the script
    // already loaded; the widget must be rendered again.
    render(<ContactForm />);
    expect(turnstile.render).toHaveBeenCalledTimes(2);
  });
});
