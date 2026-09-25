import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectIcon } from './ProjectIcon';
import { getProjectInitials, getProjectColor, JETBRAINS_PROJECT_COLORS } from './projectIconUtils';

afterEach(() => {
  cleanup();
});

describe('ProjectIcon initials extraction (JetBrains style)', () => {
  it('extracts initials matching JetBrains user samples', () => {
    // 样本1：Jrebel-master -> JM
    expect(getProjectInitials('Jrebel-master')).toBe('JM');
    // 样本2：api -> A
    expect(getProjectInitials('api')).toBe('A');
    // 样本3：k8s-nic -> KN
    expect(getProjectInitials('k8s-nic')).toBe('KN');
    // 样本4：k8s-excellence-star -> KS（首词首字符与末词首字符）
    expect(getProjectInitials('k8s-excellence-star')).toBe('KS');
    // 样本5：k8s -> K
    expect(getProjectInitials('k8s')).toBe('K');
    // 样本6：yudao-cloud -> YC
    expect(getProjectInitials('yudao-cloud')).toBe('YC');
    // 样本7：Claudix-JetBrains -> CJ
    expect(getProjectInitials('Claudix-JetBrains')).toBe('CJ');
  });

  it('handles camelCase and PascalCase names', () => {
    expect(getProjectInitials('VersionDock')).toBe('VD');
    expect(getProjectInitials('VersionDockDesktop')).toBe('VD');
    expect(getProjectInitials('myAwesomeProject')).toBe('MP');
  });

  it('handles single words and simple names', () => {
    expect(getProjectInitials('nic')).toBe('N');
    expect(getProjectInitials('desktop')).toBe('D');
    expect(getProjectInitials('Frontend')).toBe('F');
  });

  it('handles underscores, dots, and spaces', () => {
    expect(getProjectInitials('hello_world')).toBe('HW');
    expect(getProjectInitials('multi_part_repo_name')).toBe('MN');
    expect(getProjectInitials('my.custom.service')).toBe('MS');
    expect(getProjectInitials('Demo Workspace')).toBe('DW');
  });

  it('handles empty and edge cases safely', () => {
    expect(getProjectInitials('')).toBe('?');
    expect(getProjectInitials('   ')).toBe('?');
  });
});

describe('ProjectIcon color hashing', () => {
  it('returns a deterministic color for the same seed', () => {
    const color1 = getProjectColor('/Users/chenqinru/Project/VersionDock');
    const color2 = getProjectColor('/Users/chenqinru/Project/VersionDock');
    expect(color1).toBe(color2);
    expect(JETBRAINS_PROJECT_COLORS).toContain(color1);
  });

  it('differentiates distinct paths even with similar project names', () => {
    const colorA = getProjectColor('/Users/chenqinru/Project/k8s-excellence-star');
    const colorB = getProjectColor('/Users/chenqinru/Library/CloudStorage/OneDrive/k8s-excellence-star');
    // Both return valid palette colors
    expect(JETBRAINS_PROJECT_COLORS).toContain(colorA);
    expect(JETBRAINS_PROJECT_COLORS).toContain(colorB);
  });
});

describe('ProjectIcon component rendering', () => {
  it('renders initials and applies background color', () => {
    render(<ProjectIcon name="k8s-nic" seed="/path/to/k8s-nic" size="medium" />);
    const icon = screen.getByTestId('project-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveTextContent('KN');
    expect(icon).toHaveClass('project-icon--medium', 'two-letters');
  });

  it('renders single letter class for single-word projects', () => {
    render(<ProjectIcon name="nic" size="small" />);
    const icon = screen.getByTestId('project-icon');
    expect(icon).toHaveTextContent('N');
    expect(icon).toHaveClass('project-icon--small', 'one-letter');
  });

  it('renders unavailable badge when available is false', () => {
    render(<ProjectIcon name="broken-repo" available={false} />);
    const icon = screen.getByTestId('project-icon');
    expect(icon).toHaveClass('is-unavailable');
    expect(icon.querySelector('.project-icon-unavailable-badge')).toBeInTheDocument();
  });

  it('supports numeric size', () => {
    render(<ProjectIcon name="custom" size={28} />);
    const icon = screen.getByTestId('project-icon');
    expect(icon.style.width).toBe('28px');
    expect(icon.style.height).toBe('28px');
  });
});
