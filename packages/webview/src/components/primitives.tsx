import React from 'react';

/* Inline SVG icon set ported 1:1 from new-ui.html (thin-stroke, 24×24,
   currentColor). Each icon is a component accepting { size, className, style }
   so existing call-sites (<Icon.Play size={14} className="spin" />) keep working. */

type IconProps = { size?: number; className?: string; style?: React.CSSProperties };

const svg = (body: React.ReactNode, opts: { fill?: boolean; sw?: number } = {}) => {
  const { fill = false, sw = 2 } = opts;
  const C: React.FC<IconProps> = ({ size = 16, className, style }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {body}
    </svg>
  );
  return C;
};

/* Small native UI primitives styled after VS Code. */

export const Modal: React.FC<{
  title: string;
  open: boolean;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: number;
  children?: React.ReactNode;
}> = ({ title, open, onClose, footer, width = 520, children }) => {
  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width, maxWidth: 'calc(100vw - 32px)' }}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <Icon.X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">{label}{hint && <span className="field-hint"> — {hint}</span>}</span>
    {children}
  </label>
);

export const CheckRow: React.FC<{ label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }> =
  ({ label, checked, disabled, onChange }) => (
    <label className={`check-row ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );

export const ProgressBar: React.FC<{ percent: number }> = ({ percent }) => (
  <div className="progress-bar">
    <div className="progress-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
  </div>
);

/** Meta value cell; missing values show a descriptive muted placeholder instead of a bare dash. */
export const metaValue = (value: string | undefined, placeholder: string, mono = false) =>
  value
    ? <span className={`small${mono ? ' mono' : ''}`}>{value}</span>
    : <span className="small muted placeholder">{placeholder}</span>;

/* Consistent icon exports for the app — paths ported from new-ui.html. */
export const Icon = {
  Play: svg(<path d="M8 5v14l11-7z" />, { fill: true }),
  Stop: svg(<rect x="6" y="6" width="12" height="12" rx="2" />, { fill: true }),
  X: svg(<path d="M18 6 6 18M6 6l12 12" />),
  Check: svg(<path d="M20 6 9 17l-5-5" />),
  Info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>),
  Plus: svg(<path d="M12 5v14M5 12h14" />, { sw: 2.2 }),
  Search: svg(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>),
  Pencil: svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />),
  Trash2: svg(<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />),
  Copy: svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>),
  Upload: svg(<path d="M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />),
  RotateCw: svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>),
  Lock: svg(<><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>),
  Settings: svg(<><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h6M14 18h6" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="12" cy="18" r="2" /></>),
  Sliders: svg(<><path d="M4 7h5M13 7h7M4 12h9M17 12h3M4 17h11M19 17h1" /><circle cx="11" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="17" cy="17" r="2" /></>),
  List: svg(<path d="M4 6h16M4 12h16M4 18h10" />),
  More: svg(<><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></>, { fill: true }),
  ChevronRight: svg(<path d="m9 6 6 6-6 6" />, { sw: 2.5 }),
  ChevronDown: svg(<path d="m6 9 6 6 6-6" />, { sw: 2.5 }),
  ChevronUp: svg(<path d="m6 15 6-6 6 6" />, { sw: 2.5 }),
  GitBranch: svg(<><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 1-12 5.5" /></>),
  Bot: svg(<><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M9 14h.01M15 14h.01" /></>),
  Zap: svg(<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />),
  Terminal: svg(<><path d="m4 17 6-5-6-5" /><path d="M12 19h8" /></>),
  User: svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></>),
  FolderOpen: svg(<><path d="M4 8V6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" /><path d="M2.5 11h19l-2 8a2 2 0 0 1-2 1.5H6.5a2 2 0 0 1-2-1.5Z" /></>),
  GripVertical: svg(<><circle cx="9" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="15" cy="18" r="1.4" /></>, { fill: true }),
  Sparkles: svg(<><path d="M12 3l1.7 4.8L18.5 9.5 13.7 11.2 12 16l-1.7-4.8L5.5 9.5l4.8-1.7Z" /><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" /></>),
  GraphIcon: svg(<><rect x="3" y="4" width="7" height="7" rx="1" /><rect x="14" y="13" width="7" height="7" rx="1" /><path d="M10 7h4v6" /></>),
  Chart: svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  Clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  File: svg(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></>),
};
