'use client';

import { useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLocale, interpolate } from '@/lib/i18n';
import { useDialogFocus } from '@/components/useDialogFocus';

interface PRScanButtonProps {
  owner: string;
  repo: string;
  /** Render the trigger as a row of the surrounding `role="menu"` (same look as its siblings). */
  menuItem?: boolean;
  /** Focus target on close when the menuitem is gone (the menu's own button). */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}

const BUTTON_CLASS =
  'px-3 py-1.5 bg-gray-800 text-gray-300 text-xs font-medium rounded-md hover:bg-gray-700 transition-colors border border-gray-700';
const MENU_ITEM_CLASS =
  'w-full text-left px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors';

interface ScanResult {
  commented: boolean;
  newCVECount: number;
  commentUrl: string | null;
}

export function PRScanButton({ owner, repo, menuItem = false, fallbackFocusRef }: PRScanButtonProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [prNumber, setPrNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The trigger renders as a row of a `role="menu"` popup, so the modal is
  // portaled to document.body: an inline overlay would become a menu child
  // and break aria-required-children. Never on the server (document.body
  // does not exist there); the modal only ever opens on click, by which
  // time the client has mounted.
  const [mounted] = useState(() => typeof window !== 'undefined');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Escape closes only the dialog (the surrounding menu stays open), focus
  // goes back to the menuitem that opened it, which is still mounted.
  useDialogFocus({
    open: open && mounted,
    rootRef: dialogRef,
    initialFocus: () => inputRef.current,
    onEscape: () => setOpen(false),
    returnFocusRef: triggerRef,
    fallbackFocusRef,
    lockScroll: true,
  });

  async function handleScan() {
    const num = parseInt(prNumber, 10);
    if (!num || num < 1) {
      setError(t['prScan.invalidNumber']);
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/pr-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner, repo, prNumber: num }),
      });
      const data = (await res.json()) as ScanResult & { error?: string };

      if (!res.ok) {
        setError(data.error ?? t['prScan.failed']);
        return;
      }
      setResult(data);
    } catch {
      setError(t['prScan.networkError']);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => {
          setOpen(true);
          setResult(null);
          setError(null);
        }}
        role={menuItem ? 'menuitem' : undefined}
        className={menuItem ? MENU_ITEM_CLASS : BUTTON_CLASS}
      >
        {t['prScan.button']}
      </button>

      {open &&
        mounted &&
        createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pr-scan-modal-title"
          data-pr-scan-portal
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setOpen(false)}
        >
          <div
            ref={dialogRef}
            className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="pr-scan-modal-title" className="text-base font-semibold text-white mb-1">{t['prScan.title']}</h3>
            <p className="text-sm text-gray-400 mb-4">
              {interpolate(t['prScan.desc'], { owner, repo })}
            </p>

            <div className="mb-4">
              <label htmlFor="pr-scan-modal-input" className="block text-xs font-medium text-gray-400 mb-1.5">
                {t['prScan.label']}
              </label>
              <input
                id="pr-scan-modal-input"
                ref={inputRef}
                type="number"
                min={1}
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder={t['prScan.placeholder']}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
                onKeyDown={(e) => e.key === 'Enter' && void handleScan()}
              />
            </div>

            {error && (
              <div className="mb-3 text-sm text-red-400 bg-red-950/50 border border-red-900/50 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {result && (
              <div className="mb-3 text-sm bg-emerald-950/50 border border-emerald-900/50 rounded-lg px-3 py-2">
                <div className="font-medium text-emerald-400">
                  {result.newCVECount > 0
                    ? interpolate(t['prScan.foundCVEs'], { count: result.newCVECount })
                    : t['prScan.noCVEs']}
                </div>
                {result.commented && result.commentUrl && (
                  <a
                    href={result.commentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 text-xs mt-1 flex items-center min-h-6 transition-colors"
                  >
                    {t['prScan.viewComment']}
                  </a>
                )}
                {!result.commented && (
                  <p className="text-xs text-gray-400 mt-1">
                    {t['prScan.noComment']}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
              >
                {t['prScan.cancel']}
              </button>
              <button
                onClick={() => void handleScan()}
                disabled={loading || !prNumber}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {loading ? t['prScan.scanning'] : t['prScan.start']}
              </button>
            </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
