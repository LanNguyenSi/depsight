export interface SecretRowActionsLabels {
  generate: string;
  rotate: string;
  remove: string;
  working: string;
  unavailable: string;
}

interface Props {
  configured: boolean;
  /** False when the server has no key material: Generate and Rotate cannot succeed. */
  available: boolean;
  busy: boolean;
  labels: SecretRowActionsLabels;
  onGenerate: () => void;
  onRotate: () => void;
  onRemove: () => void;
}

/**
 * Per-repository actions of the webhook secret list. Generate and Rotate need
 * the server's key material; while it is missing they are disabled with the
 * reason as their title (the API would answer 503). Remove needs no key and
 * stays available.
 */
export function SecretRowActions({
  configured,
  available,
  busy,
  labels,
  onGenerate,
  onRotate,
  onRemove,
}: Props) {
  const sealDisabled = busy || !available;
  const reason = available ? undefined : labels.unavailable;
  if (configured) {
    return (
      <>
        <button
          type="button"
          disabled={sealDisabled}
          title={reason}
          onClick={onRotate}
          className="text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
        >
          {busy ? labels.working : labels.rotate}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          className="text-red-400 hover:text-red-300 disabled:opacity-50 transition-colors"
        >
          {labels.remove}
        </button>
      </>
    );
  }
  return (
    <button
      type="button"
      disabled={sealDisabled}
      title={reason}
      onClick={onGenerate}
      className="text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
    >
      {busy ? labels.working : labels.generate}
    </button>
  );
}
