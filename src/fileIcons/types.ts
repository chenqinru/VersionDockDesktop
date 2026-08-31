import type { FileIconThemePreference } from '../bindings/generated';

export type FileIconTheme = FileIconThemePreference;

export type IconResult =
  | { type: 'svg'; svg: string }
  | { type: 'codicon'; icon: string; tone: string };

export interface IconResolver {
  resolve: (name: string, isFolder: boolean, isOpen: boolean) => IconResult;
}
