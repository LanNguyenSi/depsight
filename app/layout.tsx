import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { LocaleProvider } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'depsight',
  description: 'GitHub-connected developer security dashboard for CVEs, licenses, and dependency health',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const locale = (cookieStore.get('locale')?.value as Locale) || 'de';

  return (
    <html lang={locale}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-gray-950 text-gray-100 font-sans">
        <LocaleProvider initialLocale={locale}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
