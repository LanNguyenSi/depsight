'use client';

// Presentational pieces of the dashboard repo header, kept separate so
// their markup can be rendered in node tests.

// The tabs rewrite the `tab=` search param, so they are navigation, not
// in-page panels: the active one carries aria-current="page" and no
// tablist/tabpanel roles are used.
export function RepoTabButton({
  active,
  label,
  count,
  onSelect,
}: {
  active: boolean;
  label: string;
  count: number | undefined;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
        active
          ? 'text-blue-400 border-blue-400'
          : 'text-gray-400 border-transparent hover:text-gray-300'
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 text-gray-400 tabular-nums">{count}</span>
      )}
    </button>
  );
}

export function ActionsMenuTrigger({
  open,
  label,
  onClick,
  onKeyDown,
  buttonRef,
}: {
  open: boolean;
  label: string;
  onClick: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-haspopup="menu"
      aria-expanded={open}
      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 transition-colors"
    >
      {label}
      <svg viewBox="0 0 20 20" className={`w-3.5 h-3.5 fill-current transition-transform ${open ? 'rotate-180' : ''}`}>
        <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
      </svg>
    </button>
  );
}
