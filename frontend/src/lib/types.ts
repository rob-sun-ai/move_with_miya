export interface Location {
  id: number;
  name?: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface Teacher {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  role: string;
}

export interface YogaClass {
  id: number;
  name: string;
  teacherIds: string[];
  capacity: number;
  cost: string;
  description: string;
  duration: number;
  imageUrl?: string | null;
  startDate: string;
  endDate: string;
  status: string;
  locationId: number;
  location: Location;
  isPrivate: boolean;
  registrationCount?: number;
  waitlistEnabled?: boolean;
  cancellationCutoffHours?: number;
  refundPolicy?: RefundTier[];
  teachers?: Teacher[];
}

export interface RefundTier {
  hoursBeforeStart: number;
  percentage: number;
}

export type UserRole = 'ADMIN' | 'MEMBER' | 'VIEWER' | 'TEACHER';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  role: UserRole;
  phoneNumber?: string | null;
  preferredName?: string | null;
  yogaExperience?: string | null;
  banned?: boolean;
}

export interface Registration {
  id: number;
  userId: string;
  classId: number;
  status: string;
  registeredAt: string;
  canceledAt?: string | null;
  waitlistedAt?: string | null;
  promotedAt?: string | null;
  cancellationReason?: string | null;
  source?: string;
  waitlistPosition?: number;
  user?: {
    id: string;
    firstName: string;
    lastName: string;
    avatarUrl?: string | null;
    role: string;
  } | null;
  class?: {
    id: number;
    name: string;
    startDate: string;
    endDate: string;
  } | null;
}

export interface ContactSubmission {
  id: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  role: string;
  banned: boolean;
}

export interface Payment {
  id: string;
  userId: string;
  classId: number;
  amountCents: number;
  currency: string;
  status: string;
  refundStatus: string;
  refundPercentage?: number | null;
  refundAmountCents?: number | null;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeRefundId?: string | null;
  createdAt?: string;
  paidAt?: string | null;
  refundedAt?: string | null;
  refundError?: string | null;
}
