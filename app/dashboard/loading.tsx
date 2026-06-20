export default function DashboardLoading() {
  return (
    <div className="min-h-screen bg-gray-950 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex gap-6">
          {/* Repo list sidebar skeleton */}
          <div className="w-72 shrink-0 space-y-3 animate-pulse">
            <div className="h-9 bg-gray-800 rounded-lg" />
            <div className="h-9 bg-gray-800 rounded-lg" />
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-14 bg-gray-900 border border-gray-800 rounded-lg" />
            ))}
          </div>

          {/* Detail panel skeleton */}
          <div className="flex-1 space-y-4 animate-pulse">
            {/* Tabs */}
            <div className="flex gap-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-8 w-20 bg-gray-800 rounded-lg" />
              ))}
            </div>
            {/* Content area */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
              <div className="h-6 w-48 bg-gray-800 rounded" />
              <div className="grid grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-20 bg-gray-800/50 rounded-lg" />
                ))}
              </div>
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-12 bg-gray-800/50 rounded-lg" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
