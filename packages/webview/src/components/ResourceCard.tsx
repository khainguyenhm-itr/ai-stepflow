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
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
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
  onEdit,
  bookmarked = false,
  onToggleBookmark
}) => (
  <div className={`card ${bookmarked ? 'bookmarked' : ''}`}>
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
        {onToggleBookmark && (
          <button
            className={`icon-btn bookmark ${bookmarked ? 'active' : ''}`}
            title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
            aria-pressed={bookmarked}
            onClick={onToggleBookmark}
          >
            <Icon.Bookmark size={14} fill={bookmarked ? 'currentColor' : 'none'} />
          </button>
        )}
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

export const EmptyState: React.FC<{ title: string; text?: string; icon: React.ReactNode }> = ({ title, text, icon }) => (
  <div className="empty">
    <div className="empty-icon">{icon}</div>
    <div className="empty-title">{title}</div>
    {text && <div className="empty-text">{text}</div>}
  </div>
);
