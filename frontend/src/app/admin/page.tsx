import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import AdminDashboard from '@/components/admin/AdminDashboard';
import type {
  AdminUser,
  AuthUser,
  ContactSubmission,
  Location,
  Payment,
  Registration,
  YogaClass,
} from '@/lib/types';
import { BACKEND_URL, USER_SERVICE_URL } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Admin | Move with Miya',
  description: 'Manage classes, locations, and registrations.',
};

const ADMIN_ROLE = 'ADMIN';

async function fetchAdminData(cookieString: string) {
  const headers: Record<string, string> = {
    cookie: cookieString,
  };

  const [
    classesRes,
    locationsRes,
    contactRes,
    usersRes,
    registrationsRes,
    paymentsRes,
  ] = await Promise.all([
    fetch(`${BACKEND_URL}/classes`, { cache: 'no-store', headers }),
    fetch(`${BACKEND_URL}/locations`, { cache: 'no-store', headers }),
    fetch(`${BACKEND_URL}/contact`, { cache: 'no-store', headers }),
    fetch(`${USER_SERVICE_URL}/users`, { cache: 'no-store', headers }),
    fetch(`${BACKEND_URL}/registration`, { cache: 'no-store', headers }),
    fetch(`${BACKEND_URL}/checkout/payments`, { cache: 'no-store', headers }),
  ]);

  const classes: YogaClass[] = classesRes.ok ? await classesRes.json() : [];
  const locations: Location[] = locationsRes.ok
    ? await locationsRes.json()
    : [];
  const contact: ContactSubmission[] = contactRes.ok
    ? await contactRes.json()
    : [];
  const users: AdminUser[] = usersRes.ok ? await usersRes.json() : [];
  const registrations: Registration[] = registrationsRes.ok
    ? await registrationsRes.json()
    : [];
  const payments: Payment[] = paymentsRes.ok ? await paymentsRes.json() : [];

  return { classes, locations, contact, users, registrations, payments };
}

export default async function AdminPage() {
  const cookieStore = await cookies();
  const cookieString = cookieStore.toString();

  let user: AuthUser | null = null;
  try {
    const res = await fetch(`${USER_SERVICE_URL}/auth/me`, {
      cache: 'no-store',
      headers: { cookie: cookieString },
    });
    if (res.ok) {
      user = (await res.json()) as AuthUser;
    }
  } catch (error) {
    console.error('Failed to verify admin session:', error);
  }

  if (!user) {
    redirect('/login');
  }
  if (user.role !== ADMIN_ROLE || user.banned) {
    redirect('/dashboard');
  }

  const data = await fetchAdminData(cookieString);

  return (
    <Box>
      <AdminDashboard
        initialClasses={data.classes}
        initialLocations={data.locations}
        initialContact={data.contact}
        initialUsers={data.users}
        initialRegistrations={data.registrations}
        initialPayments={data.payments}
      />
    </Box>
  );
}
