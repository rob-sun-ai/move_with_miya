import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import ClassDetailClient from '@/components/ClassDetailClient';
import type { Registration, YogaClass } from '@/lib/types';
import { BACKEND_URL } from '@/lib/env';
import { getCurrentUser } from '@/lib/session';

const STAFF_ROLES = ['ADMIN', 'TEACHER'];

async function fetchClass(id: string): Promise<YogaClass | null> {
  // The id comes straight from the URL; anything but a class id (e.g. an
  // encoded "../") must not reach the backend as part of the path.
  if (!/^\d+$/.test(id)) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/classes/${id}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as YogaClass;
  } catch (error) {
    console.error('Failed to load class:', error);
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const cls = await fetchClass(id);
  if (!cls) {
    return {
      title: 'Class Details | Move with Miya',
      description: 'Class details and registration.',
    };
  }
  return {
    title: `${cls.name} | Move with Miya`,
    description:
      cls.description ||
      `View details and register for ${cls.name} at Move with Miya.`,
  };
}

async function fetchRegistrants(
  classId: number,
  cookieString: string,
): Promise<Registration[] | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/registration/class/${classId}`, {
      cache: 'no-store',
      headers: { cookie: cookieString },
    });
    if (!res.ok) return null;
    return (await res.json()) as Registration[];
  } catch (error) {
    console.error('Failed to load registrants:', error);
    return null;
  }
}

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const cookieString = cookieStore.toString();

  const cls = await fetchClass(id);
  if (!cls) notFound();

  const user = await getCurrentUser(cookieString);
  const isStaff = user !== null && STAFF_ROLES.includes(user.role);
  const registrants = isStaff
    ? await fetchRegistrants(cls.id, cookieString)
    : null;

  return <ClassDetailClient cls={cls} user={user} registrants={registrants} />;
}
