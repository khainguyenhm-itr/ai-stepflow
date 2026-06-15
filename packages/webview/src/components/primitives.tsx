import React from 'react';
import {
  X,
  Settings,
  Pencil,
  Info,
  Play,
  ChevronUp,
  Check,
  GripVertical,
  Plus,
  Copy,
  Upload,
  RotateCw,
  Sparkles,
  Bookmark,
  Bot,
  User,
  Trash2,
  GitBranch,
  Zap,
  AlertTriangle,
  Terminal,
  Lock
} from 'lucide-react';

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
            <X size={16} />
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

/* Consistent icon exports for the app. */
export const Icon = {
  X,
  Settings,
  Pencil,
  Info,
  Play,
  ChevronUp,
  Check,
  GripVertical,
  Plus,
  Copy,
  Upload,
  RotateCw,
  Sparkles,
  Bookmark,
  Bot,
  User,
  Trash2,
  GitBranch,
  Zap,
  Alert: AlertTriangle,
  Terminal,
  Lock
};
