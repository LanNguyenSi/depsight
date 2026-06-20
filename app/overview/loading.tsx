export default function OverviewLoading() {
  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header skeleton */}
        <div className="h-8 w-40 bg-gray-800 rounded-lg animate-pulse" />

        {/* Team health card skeleton */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 animate-pulse">
          <div className="flex items-center justify-between mb-6">
            <div className="h-5 w-48 bg-gray-800 rounded" />
            <div className="h-10 w-16 bg-gray-800 rounded" />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-gray-800/50 rounded-lg p-3 h-16" />
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex-1 h-14 bg-gray-800/50 rounded-lg" />
            ))}
          </div>
        </div>

        {/* Repo comparison table skeleton */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 animate-pulse">
          <div className="h-5 w-52 bg-gray-800 rounded mb-4" />
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-800/50 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
