export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">depsight</h1>
        <p className="text-lg text-gray-600">
          GitHub-connected Developer Security Dashboard
        </p>
        <p className="text-sm text-gray-500 mt-2">
          CVE scanning • License compliance • Dependency health
        </p>
      </div>
    </main>
  );
}
