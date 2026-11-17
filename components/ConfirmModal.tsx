'use client';

import { useRef } from 'react';
import { useDialogFocus } from '@/components/useDialogFocus';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  destructive = false,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Autofocus: cancel for destructive dialogs, confirm otherwise.
  useDialogFocus({
    open,
    rootRef: dialogRef,
    initialFocus: () => (destructive ? cancelRef.current : confirmRef.current),
    onEscape: onCancel,
  });

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      style={{ animation: 'fadeIn 150ms ease-out' }}
    >
      <div
        ref={dialogRef}
        className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl p-6 w-full max-w-md mx-4"
        style={{ animation: 'scaleIn 150ms ease-out' }}
      >
        <h3 id="confirm-modal-title" className="text-base font-semibold text-white mb-2">{title}</h3>
        <p className="text-sm text-gray-400 mb-6">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
              destructive
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
