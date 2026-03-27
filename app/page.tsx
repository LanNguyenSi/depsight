export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import Link from 'next/link';

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center max-w-md px-6">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">🔍 depsight</h1>
        <p className="text-lg text-gray-600 mb-2">
          Developer Security Dashboard
        </p>
        <p className="text-sm text-gray-500 mb-8">
          CVE-Scanning • Lizenz-Compliance • Dependency Health
        </p>
        <Link
          href="/login"
          className="inline-flex items-center gap-2 px-6 py-3 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
        >
          Mit GitHub anmelden
        </Link>
      </div>
    </main>
  );
}
