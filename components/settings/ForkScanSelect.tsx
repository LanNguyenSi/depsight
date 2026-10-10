import { forkControlState } from '@/lib/pr/webhook-secret-notice';

export interface ForkScanSelectLabels {
  title: string;
  defaultOn: string;
  defaultOff: string;
  scan: string;
  ignore: string;
  publicNote: string;
  noSecretNote: string;
}

interface Props {
  row: { configured: boolean; private: boolean; scanForks: boolean | null };
  /** The instance-wide default, shown in the "default" option's label. */
  forksDefault: boolean;
  busy: boolean;
  labels: ForkScanSelectLabels;
  onChange: (value: boolean | null) => void;
}

/**
 * Fork-scanning select of one tracked repository plus the note that explains
 * why part of it is unavailable. The disabling rules live in
 * `forkControlState`; this component only wires them to the markup.
 */
export function ForkScanSelect({ row, forksDefault, busy, labels, onChange }: Props) {
  const state = forkControlState(row);
  return (
    <>
      <label className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
        <span>{labels.title}</span>
        <select
          value={row.scanForks === null ? 'default' : String(row.scanForks)}
          disabled={busy || state.selectDisabled}
          onChange={(e) => onChange(e.target.value === 'default' ? null : e.target.value === 'true')}
          className="rounded border border-gray-800 bg-gray-950 px-1.5 py-0.5 text-xs text-gray-300 disabled:opacity-50"
        >
          <option value="default">{forksDefault ? labels.defaultOn : labels.defaultOff}</option>
          <option value="true" disabled={state.scanDisabled}>
            {labels.scan}
          </option>
          <option value="false">{labels.ignore}</option>
        </select>
      </label>
      {state.note === 'publicScanIgnored' && <div className="text-xs text-amber-400">{labels.publicNote}</div>}
      {state.note === 'noSecret' && <div className="text-xs text-gray-600">{labels.noSecretNote}</div>}
    </>
  );
}
