'use client';

import { useLocale, interpolate } from '@/lib/i18n';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  compact?: boolean;
}

export function Pagination({ page, pageSize, total, onPageChange, compact }: PaginationProps) {
  const { t } = useLocale();
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className={`flex items-center ${compact ? 'justify-between' : 'justify-between'} gap-2 text-xs`}>
      <span className="text-gray-600 tabular-nums">
        {interpolate(t['pagination.info'], { from, to, total })}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="px-2 py-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-colors"
        >
          {compact ? '‹' : t['pagination.prev']}
        </button>
        {!compact && totalPages <= 7 && Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`w-7 h-7 rounded tabular-nums transition-colors ${
              p === page
                ? 'bg-gray-800 text-white'
                : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/50'
            }`}
          >
            {p}
          </button>
        ))}
        {!compact && totalPages > 7 && (
          <span className="text-gray-600 tabular-nums px-1">
            {page} / {totalPages}
          </span>
        )}
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="px-2 py-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 transition-colors"
        >
          {compact ? '›' : t['pagination.next']}
        </button>
      </div>
    </div>
  );
}

/** Hook to slice an array by page */
export function usePagination<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
