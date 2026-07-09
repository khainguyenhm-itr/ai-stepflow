import React from 'react';
import { Icon } from './primitives';

interface ResourceCardProps {
  title: string;
  subtitle?: string;
  description: string;
  badge?: React.ReactNode;
  scopeBadge?: React.ReactNode;
  meta?: React.ReactNode;
  actions: React.ReactNode;
  onDetail: () => void;
  onEdit?: () => void;
}

export const ResourceCard: React.FC<ResourceCardProps> = ({
  title,
  subtitle,
  description,
  badge,
  scopeBadge,
  meta,
  actions,
  onDetail,
  onEdit
}) => (
  <div className="card">
    <div className="card-head">
      <div className="card-head-main">
        <div className="card-title-group">
          <span className="card-title" title={title}>{title}</span>
          {subtitle && <span className="card-subtitle" title={subtitle}>{subtitle}</span>}
        </div>
        {scopeBadge}
        {badge}
      </div>
      <div className="card-head-actions">

        {onEdit && <button className="icon-btn pencil" title="Edit" onClick={onEdit}><Icon.Pencil size={14} /></button>}
      </div>
    </div>
    <p className="card-description">{description || 'No description.'}</p>
    {meta && <div className="card-meta">{meta}</div>}
    <div className="card-actions">
      {actions}
      <button className="btn" onClick={onDetail}>Details</button>
    </div>
  </div>
);

export const EmptyState: React.FC<{ title: string; text?: string; icon: React.ReactNode; action?: React.ReactNode }> = ({ title, text, icon, action }) => (
  <div className="empty">
    <div className="empty-icon">{icon}</div>
    <div className="empty-title">{title}</div>
    {text && <div className="empty-text">{text}</div>}
    {action && <div className="empty-action">{action}</div>}
  </div>
);
