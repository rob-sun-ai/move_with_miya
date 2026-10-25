import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import AdminDashboard from '@/components/admin/AdminDashboard';
import type {
  AdminUser,
  ContactSubmission,
  Location,
  Payment,
  Registration,
  YogaClass,
} from '@/lib/types';
import { BACKEND_URL, USER_SERVICE_URL } from '@/lib/env';
import { getCurrentUser } from '@/lib/session';

export const metadata: Metadata = {
  title: 'Admin | Move with Miya',
  description: 'Manage classes, locations, and registrations.',
};

const ADMIN_ROLE = 'ADMIN';

/**
 * Loads one admin list. A failure yields an empty list plus the section name,
 * so the dashboard can say what is missing instead of showing it as empty.
 */
async function fetchList<T>(
  section: string,
  url: string,
  cookieString: string,
): Promise<{ data: T[]; failed?: string }> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { cookie: cookieString },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { data: (await res.json()) as T[] };
  } catch (error) {
    console.error(`Failed to load admin ${section}:`, error);
    return { data: [], failed: section };
  }
}

async function fetchAdminData(cookieString: string) {
  const [classes, locations, contact, users, registrations, payments] =
    await Promise.all([
      fetchList<YogaClass>('classes', `${BACKEND_URL}/classes`, cookieString),
      fetchList<Location>(
        'locations',
        `${BACKEND_URL}/locations`,
        cookieString,
      ),
      fetchList<ContactSubmission>(
        'contact submissions',
        `${BACKEND_URL}/contact`,
        cookieString,
      ),
      fetchList<AdminUser>('users', `${USER_SERVICE_URL}/users`, cookieString),
      fetchList<Registration>(
        'registrations',
        `${BACKEND_URL}/registration`,
        cookieString,
      ),
      fetchList<Payment>(
        'payments',
        `${BACKEND_URL}/checkout/payments`,
        cookieString,
      ),
    ]);

  return {
    classes: classes.data,
    locations: locations.data,
    contact: contact.data,
    users: users.data,
    registrations: registrations.data,
    payments: payments.data,
    loadErrors: [
      classes,
      locations,
      contact,
      users,
      registrations,
      payments,
    ].flatMap((result) => (result.failed ? [result.failed] : [])),
  };
}

export default async function AdminPage() {
  const cookieStore = await cookies();
  const cookieString = cookieStore.toString();

  const user = await getCurrentUser(cookieString);
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
        loadErrors={data.loadErrors}
      />
    </Box>
  );
}
