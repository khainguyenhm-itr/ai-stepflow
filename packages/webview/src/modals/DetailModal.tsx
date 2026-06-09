import React from 'react';
import { Modal, Icon } from '../components/primitives';

export type DetailItem = {
  type: 'Flow' | 'Agent' | 'Skill';
  title: string;
  description: string;
  sourcePath: string;
  meta: Record<string, string | number>;
  onDelete?: () => void;
};

interface DetailModalProps {
  item: DetailItem | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

export const DetailModal: React.FC<DetailModalProps> = ({
  item,
  onClose,
  onOpenFile
}) => (
  <Modal
    title={item ? `${item.type}: ${item.title}` : ''}
    open={!!item}
    onClose={onClose}
    width={620}
    footer={item && (
      <>
        {item.onDelete && (
          <button className="btn danger" onClick={() => { item.onDelete!(); onClose(); }}><Icon.Trash2 size={14} />Delete</button>
        )}
        <button className="btn" onClick={() => onOpenFile(item.sourcePath)}>Open Source</button>
        <button className="btn primary" onClick={onClose}>Close</button>
      </>
    )}
  >
    {item && (
      <div className="stack">
        <p className="muted">{item.description || 'No description.'}</p>
        <table className="kv-table">
          <tbody>
            {Object.entries(item.meta).map(([key, value]) => (
              <tr key={key}><td>{key}</td><td>{value}</td></tr>
            ))}
            <tr><td>Source</td><td className="mono">{item.sourcePath}</td></tr>
          </tbody>
        </table>
      </div>
    )}
  </Modal>
);
