'use client';

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { api } from '@/lib/api';

interface ServiceStatus {
  status: 'ok' | 'error';
  responseTimeMs: number;
  dependencies?: Record<string, 'ok' | 'error'>;
}

interface ObservabilitySummary {
  generatedAt: string;
  version: string;
  grafanaUrl: string | null;
  services: Record<string, ServiceStatus>;
}

export default function ObservabilityPanel() {
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      setSummary(
        await api<ObservabilitySummary>('/api/admin/observability/summary'),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Unable to load observability data.',
      );
    }
  };

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, []);

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }
  if (!summary) {
    return <Alert severity="info">Loading service health…</Alert>;
  }

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ alignItems: 'flex-start' }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          Release: {summary.version} · Updated{' '}
          {new Date(summary.generatedAt).toLocaleTimeString()}
        </Typography>
        <Button variant="outlined" onClick={() => void load()}>
          Refresh
        </Button>
        {summary.grafanaUrl && (
          <Button
            component="a"
            href={summary.grafanaUrl}
            target="_blank"
            rel="noreferrer"
            variant="outlined"
          >
            Open Grafana
          </Button>
        )}
      </Stack>
      <Grid container spacing={2}>
        {Object.entries(summary.services).map(([name, service]) => (
          <Grid key={name} size={{ xs: 12, sm: 6, md: 3 }}>
            <Paper sx={{ p: 2, height: '100%' }}>
              <Stack spacing={1}>
                <Typography variant="h6">{name}</Typography>
                <Chip
                  label={service.status === 'ok' ? 'Healthy' : 'Unavailable'}
                  color={service.status === 'ok' ? 'success' : 'error'}
                  size="small"
                  sx={{ alignSelf: 'flex-start' }}
                />
                <Typography variant="body2" color="text.secondary">
                  Response: {service.responseTimeMs} ms
                </Typography>
                {service.dependencies &&
                  Object.entries(service.dependencies).map(
                    ([dependency, status]) => (
                      <Typography
                        key={dependency}
                        variant="caption"
                        color={status === 'ok' ? 'success.main' : 'error.main'}
                      >
                        {dependency}: {status}
                      </Typography>
                    ),
                  )}
              </Stack>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Stack>
  );
}
