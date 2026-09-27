import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../test-utils';
import { api } from '@/lib/api';
import ObservabilityPanel from './ObservabilityPanel';

vi.mock('@/lib/api', () => ({ api: vi.fn() }));

const apiMock = vi.mocked(api);

const summary = {
  generatedAt: '2026-09-27T12:00:00.000Z',
  version: 'abc1234',
  grafanaUrl: null as string | null,
  services: {
    backend: {
      status: 'ok',
      responseTimeMs: 0,
      dependencies: { redis: 'ok', rabbitmq: 'error' },
    },
    'classes-service': { status: 'error', responseTimeMs: 3000 },
  },
};

async function renderPanel() {
  const view = render(<ObservabilityPanel />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}

describe('ObservabilityPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a loading message until the summary arrives', () => {
    apiMock.mockReturnValue(new Promise(() => undefined));
    render(<ObservabilityPanel />);

    expect(screen.getByText('Loading service health…')).toBeInTheDocument();
  });

  it('shows each service, its dependencies, and the release', async () => {
    apiMock.mockResolvedValue(summary);

    await renderPanel();

    expect(apiMock).toHaveBeenCalledWith('/api/admin/observability/summary');
    expect(screen.getByText(/Release: abc1234/)).toBeInTheDocument();
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Response: 3000 ms')).toBeInTheDocument();
    expect(screen.getByText('redis: ok')).toBeInTheDocument();
    expect(screen.getByText('rabbitmq: error')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open Grafana' })).toBeNull();
  });

  it('links to Grafana in a new tab when configured', async () => {
    apiMock.mockResolvedValue({
      ...summary,
      grafanaUrl: 'https://grafana.studio.test/',
    });

    await renderPanel();

    const link = screen.getByRole('link', { name: 'Open Grafana' });
    expect(link).toHaveAttribute('href', 'https://grafana.studio.test/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it.each([
    [new Error('Forbidden'), 'Forbidden'],
    ['offline', 'Unable to load observability data.'],
  ])('shows load error %p', async (error, message) => {
    apiMock.mockRejectedValue(error);

    await renderPanel();

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('reloads on demand', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    apiMock.mockResolvedValue(summary);
    await renderPanel();

    apiMock.mockResolvedValue({ ...summary, version: 'def5678' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(/Release: def5678/)).toBeInTheDocument();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes every 30 seconds and recovers from errors', async () => {
    apiMock.mockRejectedValueOnce(new Error('Gateway timeout'));
    apiMock.mockResolvedValue(summary);
    await renderPanel();
    expect(screen.getByText('Gateway timeout')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Gateway timeout')).toBeNull();
    expect(screen.getByText('backend')).toBeInTheDocument();
  });

  it('stops refreshing after it is closed', async () => {
    apiMock.mockResolvedValue(summary);
    const { unmount } = await renderPanel();

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('does not load at all when closed before the first load', async () => {
    apiMock.mockResolvedValue(summary);
    const { unmount } = render(<ObservabilityPanel />);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(apiMock).not.toHaveBeenCalled();
  });
});
