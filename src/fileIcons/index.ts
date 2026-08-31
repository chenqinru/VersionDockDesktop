import type { FileIconTheme, IconResult } from './types';
import { materialResolver } from './material';
import { catppuccinResolver } from './catppuccin';
import { setiResolver } from './seti';
import { codiconResolver } from './codicon';

export * from './types';

export function resolveFileIcon(
  name: string,
  isFolder = false,
  isOpen = false,
  theme: FileIconTheme = 'material',
): IconResult {
  switch (theme) {
    case 'catppuccin':
      return catppuccinResolver.resolve(name, isFolder, isOpen);
    case 'seti':
      return setiResolver.resolve(name, isFolder, isOpen);
    case 'codicon':
      return codiconResolver.resolve(name, isFolder, isOpen);
    case 'material':
    default:
      return materialResolver.resolve(name, isFolder, isOpen);
  }
}
