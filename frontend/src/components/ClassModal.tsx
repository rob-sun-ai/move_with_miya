'use client';

import { useState } from 'react';
import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Link from 'next/link';
import { format } from 'date-fns';
import { api } from '@/lib/api';
import { formatCost, fullName, locationLabel } from '@/lib/format';
import type { YogaClass } from '@/lib/types';

interface ClassModalProps {
  cls: YogaClass;
  currentUserId?: string | null;
  isRegistered: boolean;
  registrationStatus?: string;
  onClose: () => void;
  onRegisteredChange: (classId: number, status: string) => void;
}

export default function ClassModal({
  cls,
  currentUserId = null,
  isRegistered,
  registrationStatus,
  onClose,
  onRegisteredChange,
}: ClassModalProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const registered = isRegistered;
  const currentStatus =
    registrationStatus ?? (registered ? 'Registered' : null);
  const teachers = cls.teachers ?? [];
  // eslint-disable-next-line react-hooks/purity -- time comparison must reflect "now"
  const hasEnded = new Date(cls.endDate).getTime() < Date.now();
  const registrationClosed =
    hasEnded || cls.status === 'Canceled' || cls.status === 'Completed';

  const locationName = locationLabel(cls.location);

  const handleRegister = async () => {
    if (!currentUserId) return;
    setStatus('loading');
    try {
      const registration = await api<{ status: string }>(
        `/api/registration/class/${cls.id}/user/${currentUserId}`,
        {
          method: 'POST',
        },
      );
      onRegisteredChange(cls.id, registration.status ?? 'Registered');
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      const err = error as { status?: number; message?: string };
      if (
        err.status === 409 &&
        err.message === 'Already registered for this class'
      ) {
        onRegisteredChange(cls.id, 'Registered');
        setStatus('idle');
      } else {
        setMessage(err.message || 'Registration failed.');
      }
    }
  };

  const handleCancel = async () => {
    if (!currentUserId) return;
    setStatus('loading');
    try {
      await api(`/api/registration/class/${cls.id}/me`, { method: 'DELETE' });
      onRegisteredChange(cls.id, 'Canceled');
      setStatus('idle');
    } catch (error) {
      setStatus('error');
      const err = error as { message?: string };
      setMessage(err.message || 'Cancellation failed.');
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h6" component="span" sx={{ flexGrow: 1 }}>
            {cls.name}
          </Typography>
          {hasEnded && <Chip label="Ended" color="default" size="small" />}
          {currentStatus === 'Registered' && (
            <Chip label="Registered" color="success" size="small" />
          )}
          {currentStatus === 'Waitlisted' && (
            <Chip label="Waitlisted" color="warning" size="small" />
          )}
          {cls.isPrivate ? (
            <Chip label="Private" color="secondary" size="small" />
          ) : (
            <Chip
              label="Public"
              color="primary"
              variant="outlined"
              size="small"
            />
          )}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {format(new Date(cls.startDate), 'EEEE, MMMM d, yyyy')} at{' '}
              {format(new Date(cls.startDate), 'h:mm a')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {cls.duration} minutes • {cls.registrationCount ?? 0}/
              {cls.capacity} registered • {formatCost(cls.cost)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {locationName}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {teachers.length > 0 ? (
              <>
                <AvatarGroup
                  max={4}
                  sx={{ '& .MuiAvatar-root': { width: 32, height: 32 } }}
                >
                  {teachers.map((t) => (
                    <Avatar
                      key={t.id}
                      src={t.avatarUrl ?? undefined}
                      alt={fullName(t)}
                    />
                  ))}
                </AvatarGroup>
                <Typography variant="body2" color="text.secondary">
                  {teachers.map(fullName).join(', ')}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                No teacher assigned
              </Typography>
            )}
          </Stack>
          <Divider />
          <Typography variant="body1">
            {cls.description || 'No description available.'}
          </Typography>
          {status === 'error' && <Alert severity="error">{message}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          Close
        </Button>
        <Button component={Link} href={`/classes/${cls.id}`}>
          View More
        </Button>
        {registrationClosed ? (
          <Button variant="outlined" disabled>
            {hasEnded ? 'Class ended' : 'Registration closed'}
          </Button>
        ) : currentUserId ? (
          currentStatus === 'Registered' || currentStatus === 'Waitlisted' ? (
            <Button
              variant="outlined"
              color="error"
              disabled={status === 'loading'}
              onClick={handleCancel}
            >
              {status === 'loading' ? (
                <CircularProgress size={20} color="inherit" />
              ) : currentStatus === 'Waitlisted' ? (
                'Leave Waitlist'
              ) : (
                'Cancel Registration'
              )}
            </Button>
          ) : cls.isPrivate ? (
            <Button
              component={Link}
              href={`/classes/${cls.id}`}
              variant="contained"
            >
              View details to register
            </Button>
          ) : (
            <Button
              variant="contained"
              disabled={status === 'loading'}
              onClick={handleRegister}
            >
              {status === 'loading' ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                'Register'
              )}
            </Button>
          )
        ) : (
          <Button component={Link} href="/login" variant="contained">
            Sign in to register
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
