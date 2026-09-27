'use client';

import { useEffect, useState } from 'react';
import Avatar from '@mui/material/Avatar';
import AvatarGroup from '@mui/material/AvatarGroup';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Link from 'next/link';
import { format } from 'date-fns';
import { api } from '@/lib/api';
import { startCheckout } from '@/lib/checkout';
import { formatCost, fullName, locationLabel } from '@/lib/format';
import type { AuthUser, Registration, YogaClass } from '@/lib/types';

interface ClassDetailClientProps {
  cls: YogaClass;
  user?: AuthUser | null;
  registrants?: Registration[] | null;
}

export default function ClassDetailClient({
  cls,
  user = null,
  registrants = null,
}: ClassDetailClientProps) {
  const [status, setStatus] = useState<
    'checking' | 'idle' | 'loading' | 'registered' | 'waitlisted' | 'error'
  >('checking');
  const [message, setMessage] = useState('');
  const [experienceDialogOpen, setExperienceDialogOpen] = useState(false);
  const [experienceDraft, setExperienceDraft] = useState(
    user?.yogaExperience ?? '',
  );
  const [experienceError, setExperienceError] = useState('');
  const [experienceSaving, setExperienceSaving] = useState(false);
  const [hasYogaExperience, setHasYogaExperience] = useState(
    Boolean(user?.yogaExperience?.trim()),
  );

  const locationName = locationLabel(cls.location);
  const teachers = cls.teachers ?? [];
  // eslint-disable-next-line react-hooks/purity -- time comparison must reflect "now"
  const hasEnded = new Date(cls.endDate).getTime() < Date.now();
  const registrationClosed =
    hasEnded || cls.status === 'Canceled' || cls.status === 'Completed';

  useEffect(() => {
    if (!user) return;
    let ignore = false;
    api<Registration>(`/api/registration/class/${cls.id}/me`)
      .then((registration) => {
        if (!ignore) {
          if (registration.status === 'Waitlisted') setStatus('waitlisted');
          else if (registration.status === 'Canceled') {
            setStatus('idle');
            setMessage('Your previous registration was canceled.');
          } else setStatus('registered');
        }
      })
      .catch(() => {
        if (!ignore) setStatus('idle');
      });
    return () => {
      ignore = true;
    };
  }, [user, cls.id]);

  const registerForClass = async () => {
    if (!user) return;
    setStatus('loading');
    try {
      if (Number(cls.cost) > 0) {
        await startCheckout(cls.id);
        return;
      }
      const registration = await api<Registration>(
        `/api/registration/class/${cls.id}/user/${user.id}`,
        {
          method: 'POST',
        },
      );
      setStatus(
        registration.status === 'Waitlisted' ? 'waitlisted' : 'registered',
      );
      setMessage('');
    } catch (error) {
      setStatus('error');
      const err = error as { status?: number; message?: string };
      if (
        err.status === 409 &&
        err.message === 'Already registered for this class'
      ) {
        setStatus('registered');
        setMessage('');
      } else if (err.status === 409 && err.message?.includes('waitlisted')) {
        setStatus('waitlisted');
        setMessage('');
      } else {
        setMessage(err.message || 'Registration failed.');
      }
    }
  };

  const handleRegister = () => {
    if (!user) return;
    if (cls.isPrivate && !hasYogaExperience) {
      setExperienceDraft(user.yogaExperience ?? '');
      setExperienceError('');
      setExperienceDialogOpen(true);
      return;
    }
    void registerForClass();
  };

  const handleExperienceSubmit = async () => {
    const experience = experienceDraft.trim();
    if (!experience) {
      setExperienceError('Please describe your yoga experience.');
      return;
    }

    setExperienceSaving(true);
    setExperienceError('');
    try {
      await api(`/api/users/${user?.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ yogaExperience: experience }),
      });
      setHasYogaExperience(true);
      setExperienceDialogOpen(false);
      await registerForClass();
    } catch (error) {
      const err = error as { message?: string };
      setExperienceError(err.message || 'Could not save your experience.');
    } finally {
      setExperienceSaving(false);
    }
  };

  const handleCancel = async () => {
    if (!user) return;
    setStatus('loading');
    try {
      await api(`/api/registration/class/${cls.id}/me`, { method: 'DELETE' });
      setStatus('idle');
      setMessage('Registration canceled.');
    } catch (error) {
      setStatus('error');
      const err = error as { message?: string };
      setMessage(err.message || 'Cancellation failed.');
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h4" component="h1" gutterBottom>
            {cls.name}
          </Typography>
          <Stack direction="row" spacing={1}>
            {hasEnded && <Chip label="Ended" color="default" size="small" />}
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
            <Chip label={cls.status} size="small" variant="outlined" />
          </Stack>
        </Box>

        <Typography variant="subtitle1">
          {format(new Date(cls.startDate), 'EEEE, MMMM d, yyyy')} at{' '}
          {format(new Date(cls.startDate), 'h:mm a')} ({cls.duration} minutes)
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {locationName} • {cls.registrationCount ?? 0}/{cls.capacity}{' '}
          registered • {formatCost(cls.cost)}
        </Typography>

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

        <Divider />

        {status === 'registered' && (
          <Alert severity="success">You are registered for this class!</Alert>
        )}
        {status === 'waitlisted' && (
          <Alert severity="warning">
            You are on the waitlist. We&apos;ll notify you if a seat opens.
          </Alert>
        )}
        {status === 'idle' && message && (
          <Alert severity="info">{message}</Alert>
        )}
        {status === 'error' && <Alert severity="error">{message}</Alert>}
        {user && cls.isPrivate && !hasYogaExperience && (
          <Alert severity="info">
            Please share your yoga experience before registering for this
            private class.
          </Alert>
        )}

        {registrationClosed ? (
          <Button variant="outlined" size="large" disabled>
            {hasEnded ? 'Class ended' : 'Registration closed'}
          </Button>
        ) : user && status === 'checking' ? (
          <Button variant="contained" size="large" disabled>
            <CircularProgress size={20} color="inherit" />
          </Button>
        ) : user ? (
          status === 'registered' || status === 'waitlisted' ? (
            <Button
              variant="outlined"
              color="error"
              size="large"
              onClick={handleCancel}
            >
              {status === 'waitlisted'
                ? 'Leave Waitlist'
                : 'Cancel Registration'}
            </Button>
          ) : (
            <Button
              variant="contained"
              size="large"
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
          <Button
            component={Link}
            href="/login"
            variant="contained"
            size="large"
          >
            Sign in to register
          </Button>
        )}

        {registrants && (
          <>
            <Divider />
            <Typography variant="h6" component="h3">
              Registered Users ({registrants.length}/{cls.capacity})
            </Typography>
            <Paper variant="outlined" sx={{ maxHeight: 320, overflow: 'auto' }}>
              <List dense>
                {registrants.length === 0 ? (
                  <ListItem>
                    <ListItemText primary="No registrations yet." />
                  </ListItem>
                ) : (
                  registrants.map((r) => (
                    <ListItem key={r.id}>
                      <ListItemAvatar>
                        <Avatar src={r.user?.avatarUrl ?? undefined} />
                      </ListItemAvatar>
                      <ListItemText
                        primary={r.user ? fullName(r.user) : r.userId}
                        secondary={r.user ? r.user.role : undefined}
                      />
                    </ListItem>
                  ))
                )}
              </List>
            </Paper>
          </>
        )}

        <Box>
          <Button component={Link} href="/classes" color="inherit">
            ← Back to all classes
          </Button>
        </Box>
      </Stack>

      <Dialog
        open={experienceDialogOpen}
        onClose={() => {
          if (!experienceSaving) setExperienceDialogOpen(false);
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Tell us about your yoga experience</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This private class requires a little background so the instructor
            can prepare for you.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={4}
            label="Yoga experience"
            value={experienceDraft}
            onChange={(event) => setExperienceDraft(event.target.value)}
            error={Boolean(experienceError)}
            helperText={
              experienceError ||
              'Include experience level, styles, or relevant limitations.'
            }
            disabled={experienceSaving}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setExperienceDialogOpen(false)}
            color="inherit"
            disabled={experienceSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleExperienceSubmit()}
            variant="contained"
            disabled={experienceSaving}
          >
            {experienceSaving ? (
              <CircularProgress size={20} color="inherit" />
            ) : (
              'Save and register'
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
