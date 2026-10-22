'use client';

import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { startOfDay } from 'date-fns';
import { locationLabel } from '@/lib/format';
import type { Location } from '@/lib/types';

export type TimeframeFilter = 'upcoming' | 'finished' | 'all';

export interface ClassFilters {
  privacy: 'all' | 'public' | 'private';
  timeframe: TimeframeFilter;
  locationId: number | null;
  dateFrom: Date | null;
  dateTo: Date | null;
}

export function getDefaultFilters(): ClassFilters {
  const now = new Date();
  return {
    privacy: 'all',
    timeframe: 'upcoming',
    locationId: null,
    dateFrom: startOfDay(now),
    dateTo: null,
  };
}

interface FilterBarProps {
  locations: Location[];
  filters: ClassFilters;
  onChange: (filters: ClassFilters) => void;
}

export default function FilterBar({
  locations,
  filters,
  onChange,
}: FilterBarProps) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      useFlexGap
      sx={{ flexWrap: 'wrap' }}
    >
      <FormControl size="small" sx={{ minWidth: 160 }}>
        <InputLabel id="privacy-filter-label">Privacy</InputLabel>
        <Select
          labelId="privacy-filter-label"
          label="Privacy"
          value={filters.privacy}
          onChange={(event) =>
            onChange({
              ...filters,
              privacy: event.target.value as ClassFilters['privacy'],
            })
          }
        >
          <MenuItem value="all">All</MenuItem>
          <MenuItem value="public">Public</MenuItem>
          <MenuItem value="private">Private</MenuItem>
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ minWidth: 170 }}>
        <InputLabel id="timeframe-filter-label">When</InputLabel>
        <Select
          labelId="timeframe-filter-label"
          label="When"
          value={filters.timeframe}
          onChange={(event) =>
            onChange({
              ...filters,
              timeframe: event.target.value as TimeframeFilter,
            })
          }
        >
          <MenuItem value="upcoming">Upcoming &amp; in progress</MenuItem>
          <MenuItem value="finished">Finished</MenuItem>
          <MenuItem value="all">All</MenuItem>
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ minWidth: 200 }}>
        <InputLabel id="location-filter-label">Location</InputLabel>
        <Select
          labelId="location-filter-label"
          label="Location"
          value={filters.locationId ?? ''}
          onChange={(event) => {
            const value = event.target.value as string | number;
            onChange({
              ...filters,
              locationId: value === '' ? null : Number(value),
            });
          }}
        >
          <MenuItem value="">All locations</MenuItem>
          {locations.map((location) => (
            <MenuItem key={location.id} value={location.id}>
              {locationLabel(location)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <DatePicker
          label="From"
          value={filters.dateFrom}
          onChange={(value) => onChange({ ...filters, dateFrom: value })}
          slotProps={{ textField: { size: 'small' } }}
        />
        <DatePicker
          label="To"
          value={filters.dateTo}
          onChange={(value) => onChange({ ...filters, dateTo: value })}
          slotProps={{ textField: { size: 'small' } }}
        />
      </Box>
    </Stack>
  );
}
