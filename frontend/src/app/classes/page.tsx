import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import ClassBrowser from '@/components/ClassBrowser';
import type { Registration, YogaClass } from '@/lib/types';
import { BACKEND_URL } from '@/lib/env';
import { getCurrentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Classes | Move with Miya',
  description:
    'Browse public and private yoga classes at Move with Miya and reserve your spot.',
};

async function fetchClasses(): Promise<{
  classes: YogaClass[];
  failed: boolean;
}> {
  try {
    const res = await fetch(`${BACKEND_URL}/classes`, {
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch classes: HTTP ${res.status}`);
    }
    const classes: YogaClass[] = await res.json();
    return { classes, failed: false };
  } catch (error) {
    console.error('Failed to load classes:', error);
    return { classes: [], failed: true };
  }
}

async function fetchSessionData(cookieString: string): Promise<{
  currentUserId: string | null;
  registeredClassIds: number[];
  registrationStates: Record<number, string>;
}> {
  const signedOut = {
    currentUserId: null,
    registeredClassIds: [],
    registrationStates: {},
  };
  const user = await getCurrentUser(cookieString);
  if (!user) return signedOut;

  try {
    const regRes = await fetch(`${BACKEND_URL}/registration/me`, {
      cache: 'no-store',
      headers: { cookie: cookieString },
    });
    const registrations: Registration[] = regRes.ok
      ? ((await regRes.json()) as Registration[])
      : [];

    const registrationStates = Object.fromEntries(
      registrations.map((registration) => [
        registration.classId,
        registration.status,
      ]),
    );
    return {
      currentUserId: user.id,
      registeredClassIds: registrations
        .filter((r) => r.status === 'Registered')
        .map((r) => r.classId),
      registrationStates,
    };
  } catch (error) {
    console.error('Failed to load session data:', error);
    return { ...signedOut, currentUserId: user.id };
  }
}

export default async function ClassesPage() {
  const cookieStore = await cookies();
  const cookieString = cookieStore.toString();
  const [classesResult, session] = await Promise.all([
    fetchClasses(),
    fetchSessionData(cookieString),
  ]);
  const { classes, failed } = classesResult;

  return (
    <Box>
      {failed && (
        <Box sx={{ px: 3, pt: 3 }}>
          <Alert severity="error">
            Could not load classes right now. Please try again later.
          </Alert>
        </Box>
      )}
      <ClassBrowser
        classes={classes}
        currentUserId={session.currentUserId}
        registeredClassIds={session.registeredClassIds}
        registrationStates={session.registrationStates}
      />
    </Box>
  );
}
