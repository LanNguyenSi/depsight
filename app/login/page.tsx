export const dynamic = 'force-dynamic';

import { signIn } from '@/lib/auth';

function GitHubButton() {
  return (
    <form
      action={async () => {
        'use server';
        await signIn('github', { redirectTo: '/dashboard' });
      }}
    >
      <button
        type="submit"
        className="w-full flex items-center justify-center gap-3 bg-white text-gray-900 font-medium py-2.5 px-4 rounded-lg hover:bg-gray-100 transition-colors text-sm"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
        Mit GitHub anmelden
      </button>
    </form>
  );
}

function DevLoginForm() {
  return (
    <form
      action={async (formData: FormData) => {
        'use server';
        const username = formData.get('username') as string;
        await signIn('dev-login', {
          username: username || 'dev',
          redirectTo: '/dashboard',
        });
      }}
      className="space-y-3"
    >
      <div className="flex items-center gap-2 text-amber-400 text-xs font-mono">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
        DEV MODE
      </div>
      <input
        name="username"
        type="text"
        placeholder="dev"
        defaultValue="dev"
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
      />
      <button
        type="submit"
        className="w-full bg-blue-600 text-white font-medium py-2.5 px-4 rounded-lg hover:bg-blue-500 transition-colors text-sm"
      >
        Dev Login
      </button>
    </form>
  );
}

export default function LoginPage() {
  const isDev = process.env.NODE_ENV === 'development';
  const hasGitHub =
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET;

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 16 16" className="w-5 h-5 text-white fill-current">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5a1 1 0 00-1 1v2.586l-1.707 1.707a1 1 0 001.414 1.414l2-2A1 1 0 009 9V6a1 1 0 00-1-1z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white">depsight</h1>
          <p className="text-gray-500 text-sm mt-1">
            Security Dashboard
          </p>
        </div>
        <div className="space-y-4">
          {hasGitHub && <GitHubButton />}
          {hasGitHub && isDev && (
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-800" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="px-2 bg-gray-900 text-gray-600">oder</span>
              </div>
            </div>
          )}
          {isDev && <DevLoginForm />}
        </div>
      </div>
    </div>
  );
}
