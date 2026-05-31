export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { SettingsClient } from './SettingsClient';

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return <SettingsClient />;
}
