import type { ReactNode } from 'react';

const EDITOR_ICON_PATHS: Record<string, string> = {
  vscode: '/icons/editors/vscode.svg',
  cursor: '/icons/editors/cursor.svg',
  windsurf: '/icons/editors/windsurf.svg',
  sublime: '/icons/editors/sublime.svg',
  webstorm: '/icons/editors/webstorm.svg',
  idea: '/icons/editors/idea.svg',
  none: '/icons/editors/system.svg',
  custom: '/icons/editors/custom.svg',
};

export function EditorIcon({ id, size = 18 }: { id: string; size?: number }): ReactNode {
  const src = EDITOR_ICON_PATHS[id] ?? EDITOR_ICON_PATHS.custom;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        objectFit: 'contain',
        display: 'block',
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );
}
