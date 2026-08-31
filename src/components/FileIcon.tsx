import { useAppStore } from '../store/appStore';
import { resolveFileIcon, type FileIconTheme } from '../fileIcons';
import { Codicon } from './Codicon';

interface Props {
  name: string;
  folder?: boolean;
  open?: boolean;
  theme?: FileIconTheme;
  className?: string;
}

export function FileIcon({ name, folder = false, open = false, theme, className = '' }: Props) {
  const globalTheme = useAppStore((state) => state.bootstrap?.state.settings?.fileIconTheme ?? 'material');
  const activeTheme = theme ?? globalTheme;

  const result = resolveFileIcon(name, folder, open, activeTheme);

  if (result.type === 'svg') {
    return (
      <span
        className={`file-type-icon file-svg-icon ${folder ? 'folder' : ''} ${className}`}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    );
  }

  return (
    <span className={`file-type-icon ${folder ? 'folder' : `tone-${result.tone}`} ${className}`}>
      <Codicon name={result.icon} />
    </span>
  );
}
