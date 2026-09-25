import React from 'react';
import { getProjectInitials, getProjectColor, type ProjectIconSize } from './projectIconUtils';

export interface ProjectIconProps {
  name: string;
  seed?: string;
  size?: ProjectIconSize;
  available?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * JetBrains 风格的项目字母图标组件
 */
export function ProjectIcon({
  name,
  seed,
  size = 'medium',
  available = true,
  className = '',
  style,
}: ProjectIconProps) {
  const initials = getProjectInitials(name);
  const color = getProjectColor(seed || name);
  const isCustomNumericSize = typeof size === 'number';
  const sizeClass = isCustomNumericSize ? '' : `project-icon--${size}`;

  const customStyle: React.CSSProperties = isCustomNumericSize
    ? {
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${Math.round(size * 0.22)}px`,
        fontSize: initials.length > 1 ? `${Math.round(size * 0.4)}px` : `${Math.round(size * 0.48)}px`,
      }
    : {};

  return (
    <span
      className={`project-icon ${sizeClass} ${initials.length > 1 ? 'two-letters' : 'one-letter'} ${!available ? 'is-unavailable' : ''} ${className}`.trim()}
      style={{
        backgroundColor: color,
        ...customStyle,
        ...style,
      }}
      aria-hidden="true"
      data-initials={initials}
      data-testid="project-icon"
    >
      <span className="project-icon-letters">{initials}</span>
      {!available && <span className="project-icon-unavailable-badge" aria-hidden="true" />}
    </span>
  );
}
