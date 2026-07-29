import React from 'react';
import {
  X,
  Settings,
  Pencil,
  Info,
  Play,
  Pause,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Check,
  GripVertical,
  Plus,
  Copy,
  Upload,
  Download,
  RotateCw,
  Sparkles,
  Bookmark,
  Bot,
  User,
  Trash2,
  GitBranch,
  GitBranchMinus,
  Zap,
  AlertTriangle,
  Terminal,
  Lock,
  Star,
  Search,
  MoreHorizontal,
  FolderOpen,
  FileText,
  List,
  SlidersHorizontal,
  History,
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
  // Intentionally no overlay-click close: popups only close via the X or a footer button.
  return (
    <div className="modal-overlay">
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

/** Small confirmation popup layered above other modals. Closes only via its buttons or X. */
export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel }) => {
  if (!open) return null;
  return (
    <div className="modal-overlay" style={{ zIndex: 300 }}>
      <div className="modal" style={{ width: 380, maxWidth: 'calc(100vw - 32px)' }}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="icon-btn" title="Close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body"><p>{message}</p></div>
        <div className="modal-foot">
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
          <button className="btn" onClick={onCancel}>{cancelLabel}</button>
        </div>
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

/** Tiny inline line chart for stat cards (used by Workflows + Overview). */
export const Sparkline: React.FC<{ data: number[]; color: string }> = ({ data, color }) => {
  const w = 76, h = 26, pad = 3;
  const max = Math.max(1, ...data);
  const n = data.length;
  // Keep the baseline off the bottom edge so a flat/no-data series still shows a visible line.
  const pts = data.map((v, i) => `${n <= 1 ? w : (i / (n - 1)) * w},${(h - pad) - (v / max) * (h - pad * 2)}`).join(' ');
  return (
    <svg className="flow-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

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
  Pause,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Check,
  GripVertical,
  Plus,
  Copy,
  Upload,
  Download,
  RotateCw,
  Sparkles,
  Bookmark,
  Bot,
  User,
  Trash2,
  GitBranch,
  GitBranchMinus,
  Zap,
  Alert: AlertTriangle,
  Terminal,
  Lock,
  Star,
  Search,
  More: MoreHorizontal,
  FolderOpen,
  FileText,
  List,
  Sliders: SlidersHorizontal,
  History,
};
