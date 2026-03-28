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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-gray-950 text-gray-100 font-sans">
        {children}
      </body>
    </html>
  );
}
