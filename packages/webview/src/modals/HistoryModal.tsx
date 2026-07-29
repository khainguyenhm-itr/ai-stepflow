import React from 'react';
import { AdhocRun } from '@claudesteps/core/types';
import { Modal, Icon } from '../components/primitives';

export interface HistoryTarget {
  kind: 'agent' | 'skill';
  name: string;
}

interface HistoryModalProps {
  target: HistoryTarget | null;
  /** null while the host is still loading the list; [] means loaded-but-empty. */
  runs: AdhocRun[] | null;
  onResume: (run: AdhocRun) => void;
  onClose: () => void;
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
};

const fmtTokens = (n?: number) => (n === undefined ? '—' : n.toLocaleString());
const fmtCost = (n?: number) => (n === undefined ? '—' : `$${n.toFixed(n < 0.01 ? 4 : 2)}`);
const shortModel = (m?: string) => (m ? m.replace(/^claude-/, '').replace(/-\d{8}$/, '') : undefined);

const fmtDuration = (ms?: number) => {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

const sum = (runs: AdhocRun[], key: 'tokensUsed' | 'costUsd') =>
  runs.reduce((acc, r) => (r[key] === undefined ? acc : acc + (r[key] as number)), 0);

/** Time-range filter options for the run history. */
const RANGES: { key: string; label: string; ms: number }[] = [
  { key: 'all', label: 'All time', ms: 0 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

export const HistoryModal: React.FC<HistoryModalProps> = ({ target, runs, onResume, onClose }) => {
  const [range, setRange] = React.useState('all');

  // Reset the range to "all" whenever a different agent/skill is opened.
  React.useEffect(() => { setRange('all'); }, [target?.kind, target?.name]);

  const rangeMs = RANGES.find(r => r.key === range)?.ms ?? 0;
  const cutoff = rangeMs ? Date.now() - rangeMs : 0;
  const filtered = runs && cutoff
    ? runs.filter(r => new Date(r.startedAt).getTime() >= cutoff)
    : runs;

  return (
    <Modal
      title={target ? `Run history — ${target.name}` : ''}
      open={!!target}
      onClose={onClose}
      width={800}
      footer={<button className="btn primary" onClick={onClose}>Close</button>}
    >
      {target && (
        runs === null ? (
          <p className="muted">Loading…</p>
        ) : runs.length === 0 ? (
          <div className="hist-empty">
            <Icon.History size={22} />
            <p className="muted">No runs recorded yet.</p>
            <p className="muted small">Runs launched from the Run button appear here.</p>
          </div>
        ) : (
          <>
            <div className="hist-toolbar">
              <div className="hist-summary">
                <div className="hist-stat">
                  <span className="hist-stat-val">{filtered!.length}</span>
                  <span className="hist-stat-lbl">Runs</span>
                </div>
                <div className="hist-stat">
                  <span className="hist-stat-val">{fmtTokens(sum(filtered!, 'tokensUsed'))}</span>
                  <span className="hist-stat-lbl">Tokens</span>
                </div>
                <div className="hist-stat">
                  <span className="hist-stat-val">{fmtCost(sum(filtered!, 'costUsd'))}</span>
                  <span className="hist-stat-lbl">Cost</span>
                </div>
              </div>
              <label className="hist-filter">
                <span className="hist-filter-lbl">Period</span>
                <select className="select" value={range} onChange={e => setRange(e.target.value)}>
                  {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>
            </div>

            {filtered!.length === 0 ? (
              <div className="hist-empty">
                <Icon.History size={22} />
                <p className="muted">No runs in this period.</p>
              </div>
            ) : (
              <div className="dwrap scroll-x">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th style={{ width: '32%' }}>Started</th>
                      <th style={{ width: '18%' }}>Model</th>
                      <th className="hist-num" style={{ width: '13%' }}>Duration</th>
                      <th className="hist-num" style={{ width: '13%' }}>Tokens</th>
                      <th className="hist-num" style={{ width: '12%' }}>Cost</th>
                      <th style={{ width: '12%' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {[...filtered!].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(run => (
                      <tr className="drow" key={run.id}>
                        <td>
                          <div className="dname">
                            <span className="dn">{fmtTime(run.startedAt)}</span>
                            {run.prompt && <span className="dsub" title={run.prompt}>{run.prompt}</span>}
                          </div>
                        </td>
                        <td>
                          {shortModel(run.modelUsed)
                            ? <span className="hist-model">{shortModel(run.modelUsed)}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td className="hist-num">{fmtDuration(run.durationMs)}</td>
                        <td className="hist-num">{fmtTokens(run.tokensUsed)}</td>
                        <td className="hist-num">{fmtCost(run.costUsd)}</td>
                        <td className="drow-actions-cell">
                          <span className="drow-actions">
                            <button className="icon-btn" title="Reopen this session" onClick={() => onResume(run)}>
                              <Icon.Play size={14} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}
    </Modal>
  );
};
