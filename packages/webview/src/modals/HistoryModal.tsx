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

const sum = (runs: AdhocRun[], key: 'tokensUsed' | 'costUsd') =>
  runs.reduce((acc, r) => (r[key] === undefined ? acc : acc + (r[key] as number)), 0);

export const HistoryModal: React.FC<HistoryModalProps> = ({ target, runs, onResume, onClose }) => (
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
          <div className="hist-summary">
            <div className="hist-stat">
              <span className="hist-stat-val">{runs.length}</span>
              <span className="hist-stat-lbl">Runs</span>
            </div>
            <div className="hist-stat">
              <span className="hist-stat-val">{fmtTokens(sum(runs, 'tokensUsed'))}</span>
              <span className="hist-stat-lbl">Tokens</span>
            </div>
            <div className="hist-stat">
              <span className="hist-stat-val">{fmtCost(sum(runs, 'costUsd'))}</span>
              <span className="hist-stat-lbl">Cost</span>
            </div>
          </div>

          <div className="dwrap scroll-x">
            <table className="dtable">
              <thead>
                <tr>
                  <th style={{ width: '36%' }}>Started</th>
                  <th style={{ width: '20%' }}>Model</th>
                  <th className="hist-num" style={{ width: '15%' }}>Tokens</th>
                  <th className="hist-num" style={{ width: '13%' }}>Cost</th>
                  <th style={{ width: '16%' }} />
                </tr>
              </thead>
              <tbody>
                {[...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(run => (
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
        </>
      )
    )}
  </Modal>
);
