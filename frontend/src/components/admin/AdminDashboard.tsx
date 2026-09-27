'use client';

import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import { format } from 'date-fns';
import { api } from '@/lib/api';
import type {
  AdminUser,
  ContactSubmission,
  Location,
  Payment,
  Registration,
  YogaClass,
} from '@/lib/types';

interface AdminDashboardProps {
  initialClasses: YogaClass[];
  initialLocations: Location[];
  initialContact: ContactSubmission[];
  initialUsers: AdminUser[];
  initialRegistrations: Registration[];
  initialPayments?: Payment[];
}

type TabValue =
  | 'classes'
  | 'locations'
  | 'registrations'
  | 'payments'
  | 'contact'
  | 'users';

const emptyClassForm = {
  name: '',
  capacity: '10',
  cost: '0',
  description: '',
  duration: '60',
  startDate: '',
  endDate: '',
  locationId: '',
  teacherIds: [] as string[],
  isPrivate: false,
  status: 'Scheduled',
  waitlistEnabled: true,
  cancellationCutoffHours: '24',
  refundTiers: [{ hoursBeforeStart: '24', percentage: '100' }],
};

const emptyLocationForm = {
  name: '',
  address: '',
  city: '',
  state: '',
  zipCode: '',
};

export default function AdminDashboard({
  initialClasses,
  initialLocations,
  initialContact,
  initialUsers,
  initialRegistrations,
  initialPayments = [],
}: AdminDashboardProps) {
  const [tab, setTab] = useState<TabValue>('classes');
  const [classes, setClasses] = useState<YogaClass[]>(initialClasses);
  const [locations, setLocations] = useState<Location[]>(initialLocations);
  const [contact, setContact] = useState<ContactSubmission[]>(initialContact);
  const [users, setUsers] = useState<AdminUser[]>(initialUsers);
  const [registrations, setRegistrations] =
    useState<Registration[]>(initialRegistrations);
  const [payments, setPayments] = useState<Payment[]>(initialPayments);

  const [classDialog, setClassDialog] = useState(false);
  const [editingClass, setEditingClass] = useState<YogaClass | null>(null);
  const [classForm, setClassForm] = useState(emptyClassForm);
  const [classErrors, setClassErrors] = useState<Record<string, string>>({});

  const [locationDialog, setLocationDialog] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [locationForm, setLocationForm] = useState(emptyLocationForm);

  const [selectedClassId, setSelectedClassId] = useState<string>('');
  const [registrationFrom, setRegistrationFrom] = useState('');
  const [registrationTo, setRegistrationTo] = useState('');

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showNotice = (msg: string) => {
    setNotice(msg);
    setError(null);
  };
  const showError = (msg: string) => {
    setError(msg);
    setNotice(null);
  };

  const handleTabChange = (value: TabValue) => {
    setTab(value);
  };

  const openNewClass = () => {
    setEditingClass(null);
    setClassErrors({});
    setClassForm({
      ...emptyClassForm,
      locationId: locations[0] ? String(locations[0].id) : '',
    });
    setClassDialog(true);
  };

  const openEditClass = (cls: YogaClass) => {
    setEditingClass(cls);
    setClassErrors({});
    setClassForm({
      name: cls.name,
      capacity: String(cls.capacity),
      cost: cls.cost,
      description: cls.description,
      duration: String(cls.duration),
      startDate: format(new Date(cls.startDate), "yyyy-MM-dd'T'HH:mm"),
      endDate: format(new Date(cls.endDate), "yyyy-MM-dd'T'HH:mm"),
      locationId: String(cls.locationId),
      teacherIds: cls.teacherIds ?? [],
      isPrivate: cls.isPrivate,
      status: cls.status,
      waitlistEnabled: cls.waitlistEnabled ?? true,
      cancellationCutoffHours: String(cls.cancellationCutoffHours ?? 24),
      refundTiers: (
        cls.refundPolicy ?? [{ hoursBeforeStart: 24, percentage: 100 }]
      ).map((tier) => ({
        hoursBeforeStart: String(tier.hoursBeforeStart),
        percentage: String(tier.percentage),
      })),
    });
    setClassDialog(true);
  };

  const saveClass = async () => {
    try {
      const errors: Record<string, string> = {};
      if (!classForm.name.trim()) errors.name = 'Name is required.';
      if (!classForm.locationId) errors.locationId = 'Location is required.';
      if (!classForm.capacity || Number(classForm.capacity) <= 0) {
        errors.capacity = 'Capacity must be greater than 0.';
      }
      if (classForm.cost === '' || Number.isNaN(Number(classForm.cost))) {
        errors.cost = 'Cost is required.';
      }
      if (
        classForm.refundTiers.some((tier) => {
          const hours = Number(tier.hoursBeforeStart);
          const percentage = Number(tier.percentage);
          return (
            !Number.isInteger(hours) ||
            hours < 0 ||
            !Number.isInteger(percentage) ||
            percentage < 0 ||
            percentage > 100
          );
        })
      ) {
        errors.refundPolicy =
          'Refund tiers must use whole hours and percentages from 0 to 100.';
      }
      if (!classForm.duration || Number(classForm.duration) <= 0) {
        errors.duration = 'Duration must be greater than 0.';
      }
      if (
        !classForm.startDate ||
        Number.isNaN(new Date(classForm.startDate).getTime())
      ) {
        errors.startDate = 'Start date is required.';
      }
      if (
        !classForm.endDate ||
        Number.isNaN(new Date(classForm.endDate).getTime())
      ) {
        errors.endDate = 'End date is required.';
      }
      if (
        !errors.startDate &&
        !errors.endDate &&
        new Date(classForm.endDate).getTime() <=
          new Date(classForm.startDate).getTime()
      ) {
        errors.endDate = 'End date must be after start date.';
      }
      if (Object.keys(errors).length > 0) {
        setClassErrors(errors);
        return;
      }
      setClassErrors({});
      const payload = {
        name: classForm.name,
        capacity: Number(classForm.capacity),
        cost: classForm.cost,
        description: classForm.description,
        duration: Number(classForm.duration),
        startDate: new Date(classForm.startDate).toISOString(),
        endDate: new Date(classForm.endDate).toISOString(),
        locationId: Number(classForm.locationId),
        teacherIds: classForm.teacherIds,
        isPrivate: classForm.isPrivate,
        status: classForm.status,
        waitlistEnabled: classForm.waitlistEnabled,
        cancellationCutoffHours: Number(classForm.cancellationCutoffHours),
        refundPolicy: classForm.refundTiers.map((tier) => ({
          hoursBeforeStart: Number(tier.hoursBeforeStart),
          percentage: Number(tier.percentage),
        })),
      };
      if (editingClass) {
        const canceling =
          classForm.status === 'Canceled' && editingClass.status !== 'Canceled';
        await api(
          `/api/classes/${editingClass.id}${canceling ? '/cancel' : ''}`,
          {
            method: canceling ? 'POST' : 'PATCH',
            body: JSON.stringify(payload),
          },
        );
      } else {
        await api('/api/classes', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      const updated = await api<YogaClass[]>('/api/classes');
      setClasses(updated);
      setClassDialog(false);
      showNotice(editingClass ? 'Class updated.' : 'Class created.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  const deleteClass = async (id: number) => {
    if (!confirm('Delete this class?')) return;
    try {
      await api(`/api/classes/${id}`, { method: 'DELETE' });
      const updated = await api<YogaClass[]>('/api/classes');
      setClasses(updated);
      showNotice('Class deleted.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  const cancelClass = async (id: number) => {
    if (!confirm('Cancel this class and notify all registrants?')) return;
    try {
      await api(`/api/classes/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Canceled by administrator' }),
      });
      const [updatedClasses, updatedRegistrations] = await Promise.all([
        api<YogaClass[]>('/api/classes'),
        api<Registration[]>('/api/registration'),
      ]);
      setClasses(updatedClasses);
      setRegistrations(updatedRegistrations);
      setPayments(await api<Payment[]>('/api/checkout/payments'));
      showNotice('Class canceled and registrations updated.');
    } catch (err) {
      showError(
        err instanceof Error ? err.message : 'Class cancellation failed.',
      );
    }
  };

  const openNewLocation = () => {
    setEditingLocation(null);
    setLocationForm(emptyLocationForm);
    setLocationDialog(true);
  };

  const openEditLocation = (loc: Location) => {
    setEditingLocation(loc);
    setLocationForm({
      name: loc.name ?? '',
      address: loc.address,
      city: loc.city,
      state: loc.state,
      zipCode: loc.zipCode,
    });
    setLocationDialog(true);
  };

  const saveLocation = async () => {
    try {
      const payload = { ...locationForm, name: locationForm.name || null };
      if (editingLocation) {
        await api(`/api/locations/${editingLocation.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/locations', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      const updated = await api<Location[]>('/api/locations');
      setLocations(updated);
      setLocationDialog(false);
      showNotice(editingLocation ? 'Location updated.' : 'Location created.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  const deleteLocation = async (id: number) => {
    if (!confirm('Delete this location?')) return;
    try {
      await api(`/api/locations/${id}`, { method: 'DELETE' });
      const updated = await api<Location[]>('/api/locations');
      setLocations(updated);
      showNotice('Location deleted.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  const cancelRegistration = async (id: number) => {
    if (!confirm('Cancel this registration?')) return;
    try {
      const updated = await api<Registration>(
        `/api/registration/${id}/cancel`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: 'Canceled by administrator' }),
        },
      );
      setRegistrations((previous) =>
        previous.map((reg) =>
          reg.id === id
            ? { ...reg, ...updated, status: updated.status ?? 'Canceled' }
            : reg,
        ),
      );
      setPayments(await api<Payment[]>('/api/checkout/payments'));
      showNotice('Registration cancelled.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Cancel failed.');
    }
  };

  const markContactRead = async (item: ContactSubmission) => {
    try {
      await api(`/api/contact/${item.id}/read`, {
        method: 'PATCH',
        body: JSON.stringify({ read: !item.read }),
      });
      setContact((previous) =>
        previous.map((submission) =>
          submission.id === item.id
            ? { ...submission, read: !item.read }
            : submission,
        ),
      );
      showNotice(
        item.read ? 'Submission marked unread.' : 'Submission marked read.',
      );
    } catch (err) {
      showError(
        err instanceof Error ? err.message : 'Read status update failed.',
      );
    }
  };

  const visibleRegistrations = registrations.filter((registration) => {
    if (selectedClassId && String(registration.classId) !== selectedClassId) {
      return false;
    }
    const startDate = registration.class?.startDate;
    if (!startDate) return !registrationFrom && !registrationTo;
    const start = new Date(startDate).getTime();
    if (
      registrationFrom &&
      start < new Date(`${registrationFrom}T00:00:00`).getTime()
    ) {
      return false;
    }
    if (
      registrationTo &&
      start > new Date(`${registrationTo}T23:59:59.999`).getTime()
    ) {
      return false;
    }
    return true;
  });

  const updateUserRole = async (id: string, role: string) => {
    try {
      await api(`/api/users/${id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, role } : u)));
      showNotice('User role updated.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Role update failed.');
    }
  };

  const toggleUserBan = async (id: string) => {
    try {
      await api(`/api/users/${id}/ban`, { method: 'PATCH' });
      setUsers((prev) =>
        prev.map((u) => (u.id === id ? { ...u, banned: !u.banned } : u)),
      );
      showNotice('User ban status updated.');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Ban update failed.');
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
        Admin
      </Typography>

      {notice && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setNotice(null)}
        >
          {notice}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Tabs value={tab} onChange={(_, v) => handleTabChange(v)} sx={{ mb: 3 }}>
        <Tab label="Classes" value="classes" />
        <Tab label="Locations" value="locations" />
        <Tab label="Registrations" value="registrations" />
        <Tab label="Payments" value="payments" />
        <Tab label="Contact" value="contact" />
        <Tab label="Users" value="users" />
      </Tabs>

      {tab === 'classes' && (
        <Stack spacing={2}>
          <Box>
            <Button variant="contained" onClick={openNewClass}>
              New Class
            </Button>
          </Box>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Start</TableCell>
                  <TableCell>Capacity</TableCell>
                  <TableCell>Cost</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Private</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {classes.map((cls) => (
                  <TableRow key={cls.id}>
                    <TableCell>{cls.name}</TableCell>
                    <TableCell>
                      {format(new Date(cls.startDate), 'MMM d, h:mm a')}
                    </TableCell>
                    <TableCell>{cls.capacity}</TableCell>
                    <TableCell>${cls.cost}</TableCell>
                    <TableCell>
                      {cls.location.name ??
                        `${cls.location.city}, ${cls.location.state}`}
                    </TableCell>
                    <TableCell>{cls.status}</TableCell>
                    <TableCell>{cls.isPrivate ? 'Yes' : 'No'}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1}>
                        <Button size="small" onClick={() => openEditClass(cls)}>
                          Edit
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          disabled={cls.status === 'Canceled'}
                          onClick={() => cancelClass(cls.id)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          onClick={() => deleteClass(cls.id)}
                        >
                          Delete
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
                {classes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} align="center">
                      No classes yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      )}

      {tab === 'locations' && (
        <Stack spacing={2}>
          <Box>
            <Button variant="contained" onClick={openNewLocation}>
              New Location
            </Button>
          </Box>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Address</TableCell>
                  <TableCell>City</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell>ZIP</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {locations.map((loc) => (
                  <TableRow key={loc.id}>
                    <TableCell>{loc.name ?? '—'}</TableCell>
                    <TableCell>{loc.address}</TableCell>
                    <TableCell>{loc.city}</TableCell>
                    <TableCell>{loc.state}</TableCell>
                    <TableCell>{loc.zipCode}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1}>
                        <Button
                          size="small"
                          onClick={() => openEditLocation(loc)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="small"
                          color="error"
                          onClick={() => deleteLocation(loc.id)}
                        >
                          Delete
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
                {locations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center">
                      No locations yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      )}

      {tab === 'registrations' && (
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <FormControl sx={{ minWidth: 280 }}>
              <InputLabel id="reg-class-label">Class</InputLabel>
              <Select
                labelId="reg-class-label"
                label="Class"
                value={selectedClassId}
                onChange={(e) => setSelectedClassId(e.target.value as string)}
              >
                <MenuItem value="">All classes</MenuItem>
                {classes.map((cls) => (
                  <MenuItem key={cls.id} value={String(cls.id)}>
                    {cls.name} —{' '}
                    {format(new Date(cls.startDate), 'MMM d, h:mm a')}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="From"
              type="date"
              value={registrationFrom}
              onChange={(event) => setRegistrationFrom(event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="To"
              type="date"
              value={registrationTo}
              onChange={(event) => setRegistrationTo(event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Stack>

          <Typography variant="body2" color="text.secondary">
            Showing {visibleRegistrations.length} of {registrations.length}{' '}
            registrations.
          </Typography>

          {selectedClassId || registrations.length > 0 ? (
            <TableContainer component={Paper}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>ID</TableCell>
                    <TableCell>User</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Registered</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleRegistrations.map((reg) => (
                    <TableRow key={reg.id}>
                      <TableCell>{reg.id}</TableCell>
                      <TableCell>
                        {reg.user
                          ? `${reg.user.firstName} ${reg.user.lastName}`.trim()
                          : reg.userId}
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block' }}
                        >
                          {reg.user ? reg.user.role : ''}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block' }}
                        >
                          {reg.class?.name ?? `Class ${reg.classId}`}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={reg.status}
                          size="small"
                          color={
                            reg.status === 'Registered' ? 'success' : 'default'
                          }
                        />
                      </TableCell>
                      <TableCell>
                        {format(new Date(reg.registeredAt), 'MMM d, h:mm a')}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          color="error"
                          onClick={() => cancelRegistration(reg.id)}
                        >
                          Cancel
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {visibleRegistrations.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center">
                        No registrations match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Alert severity="info">No registrations yet.</Alert>
          )}
        </Stack>
      )}

      {tab === 'payments' && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Payment</TableCell>
                <TableCell>Class</TableCell>
                <TableCell>Amount</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Refund</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>{payment.id.slice(0, 8)}</TableCell>
                  <TableCell>
                    {classes.find((cls) => cls.id === payment.classId)?.name ??
                      payment.classId}
                  </TableCell>
                  <TableCell>
                    {(payment.amountCents / 100).toFixed(2)}{' '}
                    {payment.currency.toUpperCase()}
                  </TableCell>
                  <TableCell>
                    <Chip label={payment.status} size="small" />
                  </TableCell>
                  <TableCell>
                    {payment.refundStatus}
                    {payment.refundAmountCents != null && (
                      <>
                        {' '}
                        ({(payment.refundAmountCents / 100).toFixed(2)}{' '}
                        {payment.currency.toUpperCase()})
                      </>
                    )}
                    {payment.refundError && (
                      <Typography
                        variant="caption"
                        color="error"
                        sx={{ display: 'block' }}
                      >
                        {payment.refundError}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    {payment.status === 'Paid' &&
                      payment.refundStatus !== 'Succeeded' && (
                        <Button
                          size="small"
                          onClick={async () => {
                            try {
                              await api(
                                `/api/checkout/payments/${payment.id}/refund`,
                                { method: 'POST' },
                              );
                              setPayments(
                                await api<Payment[]>('/api/checkout/payments'),
                              );
                              showNotice('Refund request processed.');
                            } catch (err) {
                              showError(
                                err instanceof Error
                                  ? err.message
                                  : 'Refund failed.',
                              );
                            }
                          }}
                        >
                          Refund
                        </Button>
                      )}
                  </TableCell>
                </TableRow>
              ))}
              {payments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    No payments yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {tab === 'contact' && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Message</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {contact.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    {format(new Date(item.createdAt), 'MMM d, yyyy h:mm a')}
                  </TableCell>
                  <TableCell>{item.name}</TableCell>
                  <TableCell>{item.email}</TableCell>
                  <TableCell>{item.subject}</TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>{item.message}</TableCell>
                  <TableCell>
                    <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
                      <Chip
                        label={item.read ? 'Read' : 'Unread'}
                        color={item.read ? 'default' : 'warning'}
                        size="small"
                      />
                      <Button
                        size="small"
                        onClick={() => markContactRead(item)}
                      >
                        Mark {item.read ? 'unread' : 'read'}
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {contact.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    No contact submissions.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {tab === 'users' && (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    {user.firstName} {user.lastName}
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    <FormControl size="small">
                      <Select
                        value={user.role}
                        onChange={(e) =>
                          updateUserRole(user.id, e.target.value as string)
                        }
                        sx={{ minWidth: 110 }}
                      >
                        <MenuItem value="ADMIN">Admin</MenuItem>
                        <MenuItem value="TEACHER">Teacher</MenuItem>
                        <MenuItem value="MEMBER">Member</MenuItem>
                        <MenuItem value="VIEWER">Viewer</MenuItem>
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={user.banned ? 'Banned' : 'Active'}
                      size="small"
                      color={user.banned ? 'error' : 'success'}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="small"
                      color={user.banned ? 'success' : 'warning'}
                      onClick={() => toggleUserBan(user.id)}
                    >
                      {user.banned ? 'Unban' : 'Ban'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align="center">
                    No users yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={classDialog}
        onClose={() => setClassDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{editingClass ? 'Edit Class' : 'New Class'}</DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0 }}>
            <Grid size={12}>
              <TextField
                label="Name"
                required
                fullWidth
                value={classForm.name}
                onChange={(e) =>
                  setClassForm({ ...classForm, name: e.target.value })
                }
                error={Boolean(classErrors.name)}
                helperText={classErrors.name}
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="Capacity"
                type="number"
                required
                fullWidth
                value={classForm.capacity}
                onChange={(e) =>
                  setClassForm({ ...classForm, capacity: e.target.value })
                }
                error={Boolean(classErrors.capacity)}
                helperText={classErrors.capacity}
              />
            </Grid>
            <Grid size={12}>
              <Typography variant="subtitle2">Refund tiers</Typography>
              <Typography variant="caption" color="text.secondary">
                Members receive the percentage for the highest threshold they
                meet before the cancellation cutoff.
              </Typography>
              <Stack spacing={1} sx={{ mt: 1 }}>
                {classForm.refundTiers.map((tier, index) => (
                  <Stack key={index} direction="row" spacing={1}>
                    <TextField
                      label="Hours before start"
                      type="number"
                      size="small"
                      value={tier.hoursBeforeStart}
                      onChange={(event) => {
                        const refundTiers = [...classForm.refundTiers];
                        refundTiers[index] = {
                          ...tier,
                          hoursBeforeStart: event.target.value,
                        };
                        setClassForm({ ...classForm, refundTiers });
                      }}
                    />
                    <TextField
                      label="Refund %"
                      type="number"
                      size="small"
                      value={tier.percentage}
                      onChange={(event) => {
                        const refundTiers = [...classForm.refundTiers];
                        refundTiers[index] = {
                          ...tier,
                          percentage: event.target.value,
                        };
                        setClassForm({ ...classForm, refundTiers });
                      }}
                    />
                    <Button
                      color="error"
                      disabled={classForm.refundTiers.length === 1}
                      onClick={() =>
                        setClassForm({
                          ...classForm,
                          refundTiers: classForm.refundTiers.filter(
                            (_, tierIndex) => tierIndex !== index,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </Stack>
                ))}
                {classErrors.refundPolicy && (
                  <FormHelperText error>
                    {classErrors.refundPolicy}
                  </FormHelperText>
                )}
                <Button
                  size="small"
                  onClick={() =>
                    setClassForm({
                      ...classForm,
                      refundTiers: [
                        ...classForm.refundTiers,
                        { hoursBeforeStart: '0', percentage: '0' },
                      ],
                    })
                  }
                >
                  Add refund tier
                </Button>
              </Stack>
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="Cost"
                type="number"
                required
                fullWidth
                value={classForm.cost}
                onChange={(e) =>
                  setClassForm({ ...classForm, cost: e.target.value })
                }
                error={Boolean(classErrors.cost)}
                helperText={classErrors.cost}
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="Cancellation cutoff (hours)"
                type="number"
                required
                fullWidth
                value={classForm.cancellationCutoffHours}
                onChange={(e) =>
                  setClassForm({
                    ...classForm,
                    cancellationCutoffHours: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="Duration (min)"
                type="number"
                required
                fullWidth
                value={classForm.duration}
                onChange={(e) =>
                  setClassForm({ ...classForm, duration: e.target.value })
                }
                error={Boolean(classErrors.duration)}
                helperText={classErrors.duration}
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <FormControl fullWidth>
                <InputLabel id="status-label">Status</InputLabel>
                <Select
                  labelId="status-label"
                  label="Status"
                  value={classForm.status}
                  onChange={(e) =>
                    setClassForm({ ...classForm, status: e.target.value })
                  }
                >
                  <MenuItem value="Scheduled">Scheduled</MenuItem>
                  <MenuItem value="InProgress">In Progress</MenuItem>
                  <MenuItem value="Completed">Completed</MenuItem>
                  <MenuItem value="Canceled">Canceled</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="Start"
                type="datetime-local"
                required
                fullWidth
                value={classForm.startDate}
                onChange={(e) =>
                  setClassForm({ ...classForm, startDate: e.target.value })
                }
                slotProps={{ inputLabel: { shrink: true } }}
                error={Boolean(classErrors.startDate)}
                helperText={classErrors.startDate}
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="End"
                type="datetime-local"
                required
                fullWidth
                value={classForm.endDate}
                onChange={(e) =>
                  setClassForm({ ...classForm, endDate: e.target.value })
                }
                slotProps={{ inputLabel: { shrink: true } }}
                error={Boolean(classErrors.endDate)}
                helperText={classErrors.endDate}
              />
            </Grid>
            <Grid size={12}>
              <FormControl
                fullWidth
                required
                error={Boolean(classErrors.locationId)}
              >
                <InputLabel id="loc-label">Location</InputLabel>
                <Select
                  labelId="loc-label"
                  label="Location"
                  value={classForm.locationId}
                  onChange={(e) =>
                    setClassForm({ ...classForm, locationId: e.target.value })
                  }
                >
                  {locations.map((loc) => (
                    <MenuItem key={loc.id} value={String(loc.id)}>
                      {loc.name ?? `${loc.city}, ${loc.state}`}
                    </MenuItem>
                  ))}
                </Select>
                {classErrors.locationId && (
                  <FormHelperText error>
                    {classErrors.locationId}
                  </FormHelperText>
                )}
              </FormControl>
            </Grid>
            <Grid size={12}>
              <FormControl fullWidth>
                <InputLabel id="teachers-label">Teachers</InputLabel>
                <Select
                  labelId="teachers-label"
                  label="Teachers"
                  multiple
                  value={classForm.teacherIds}
                  onChange={(e) => {
                    const value = e.target.value as string[];
                    setClassForm({ ...classForm, teacherIds: value });
                  }}
                  renderValue={(selected) => {
                    const sel = selected as string[];
                    if (sel.length === 0) return <em>No teacher assigned</em>;
                    return sel
                      .map((id) => {
                        const u = users.find((u) => u.id === id);
                        return u ? `${u.firstName} ${u.lastName}`.trim() : id;
                      })
                      .join(', ');
                  }}
                >
                  {users.map((u) => (
                    <MenuItem key={u.id} value={u.id}>
                      {`${u.firstName} ${u.lastName}`.trim()} ({u.role})
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid size={12}>
              <TextField
                label="Description"
                multiline
                minRows={2}
                fullWidth
                value={classForm.description}
                onChange={(e) =>
                  setClassForm({ ...classForm, description: e.target.value })
                }
              />
            </Grid>
            <Grid size={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={classForm.waitlistEnabled}
                    onChange={(e) =>
                      setClassForm({
                        ...classForm,
                        waitlistEnabled: e.target.checked,
                      })
                    }
                  />
                }
                label="Allow waitlist"
              />
            </Grid>
            <Grid size={12}>
              <FormControlLabel
                control={
                  <Switch
                    checked={classForm.isPrivate}
                    onChange={(e) =>
                      setClassForm({
                        ...classForm,
                        isPrivate: e.target.checked,
                      })
                    }
                  />
                }
                label="Private class"
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClassDialog(false)} color="inherit">
            Cancel
          </Button>
          <Button variant="contained" onClick={saveClass}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={locationDialog}
        onClose={() => setLocationDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {editingLocation ? 'Edit Location' : 'New Location'}
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 0 }}>
            <Grid size={12}>
              <TextField
                label="Name"
                fullWidth
                value={locationForm.name}
                onChange={(e) =>
                  setLocationForm({ ...locationForm, name: e.target.value })
                }
              />
            </Grid>
            <Grid size={12}>
              <TextField
                label="Address"
                fullWidth
                value={locationForm.address}
                onChange={(e) =>
                  setLocationForm({ ...locationForm, address: e.target.value })
                }
              />
            </Grid>
            <Grid size={{ xs: 6 }}>
              <TextField
                label="City"
                fullWidth
                value={locationForm.city}
                onChange={(e) =>
                  setLocationForm({ ...locationForm, city: e.target.value })
                }
              />
            </Grid>
            <Grid size={{ xs: 3 }}>
              <TextField
                label="State"
                fullWidth
                value={locationForm.state}
                onChange={(e) =>
                  setLocationForm({ ...locationForm, state: e.target.value })
                }
              />
            </Grid>
            <Grid size={{ xs: 3 }}>
              <TextField
                label="ZIP"
                fullWidth
                value={locationForm.zipCode}
                onChange={(e) =>
                  setLocationForm({ ...locationForm, zipCode: e.target.value })
                }
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLocationDialog(false)} color="inherit">
            Cancel
          </Button>
          <Button variant="contained" onClick={saveLocation}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
