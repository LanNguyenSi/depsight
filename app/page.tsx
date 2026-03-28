export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import Link from 'next/link';

export default async function HomePage() {
  const session = await auth();
  if (session?.user) redirect('/dashboard');

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center max-w-lg px-6">
        <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center mx-auto mb-6">
          <svg viewBox="0 0 24 24" className="w-7 h-7 text-white fill-current">
            <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm0 3a1 1 0 00-1 1v3.586l-2.707 2.707a1 1 0 001.414 1.414l3-3A1 1 0 0013 12V8a1 1 0 00-1-1z" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-white mb-3">depsight</h1>
        <p className="text-base text-gray-400 mb-1">
          Developer Security Dashboard
        </p>
        <p className="text-sm text-gray-500 mb-10">
          CVE-Scanning &middot; Lizenz-Compliance &middot; Dependency Health
        </p>
        <Link
          href="/login"
          className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-500 transition-colors"
        >
          Anmelden
        </Link>
      </div>
    </main>
  );
}
