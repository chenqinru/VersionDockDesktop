import { adaptLightPalette } from './lightPalette';
import type { FileIconTheme, IconResult } from './types';
import { materialResolver } from './material';
import { catppuccinResolver, catppuccinLightIcon } from './catppuccin';
import { setiResolver } from './seti';
import { codiconResolver } from './codicon';

export * from './types';

export function resolveFileIcon(
  name: string,
  isFolder = false,
  isOpen = false,
  theme: FileIconTheme = 'material',
  light = false,
): IconResult {
  switch (theme) {
    case 'catppuccin': {
      const result = catppuccinResolver.resolve(name, isFolder, isOpen);
      return light && result.type === 'svg' ? { ...result, svg: catppuccinLightIcon(result.svg) } : result;
    }
    case 'seti': {
      const result = setiResolver.resolve(name, isFolder, isOpen);
      return light && result.type === 'svg' ? { ...result, svg: adaptLightPalette(result.svg, 'seti') } : result;
    }
    case 'codicon':
      return codiconResolver.resolve(name, isFolder, isOpen);
    case 'material':
    default:
      {
        const result = materialResolver.resolve(name, isFolder, isOpen);
        return light && result.type === 'svg' ? { ...result, svg: adaptLightPalette(result.svg, 'material') } : result;
      }
  }
}
