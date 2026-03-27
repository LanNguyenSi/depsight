import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'depsight',
  description: 'GitHub-connected developer security dashboard for CVEs, licenses, and dependency health',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
