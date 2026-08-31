import type { IconResolver, IconResult } from './types';

const EXTENSION_ICONS: Record<string, { icon: string; tone: string }> = {
  ts: { icon: 'symbol-variable', tone: 'typescript' },
  tsx: { icon: 'symbol-variable', tone: 'typescript' },
  js: { icon: 'symbol-variable', tone: 'javascript' },
  jsx: { icon: 'symbol-variable', tone: 'javascript' },
  mjs: { icon: 'symbol-variable', tone: 'javascript' },
  cjs: { icon: 'symbol-variable', tone: 'javascript' },
  vue: { icon: 'symbol-method', tone: 'vue' },
  svelte: { icon: 'symbol-method', tone: 'svelte' },
  rs: { icon: 'symbol-namespace', tone: 'rust' },
  java: { icon: 'symbol-namespace', tone: 'java' },
  kt: { icon: 'symbol-namespace', tone: 'kotlin' },
  py: { icon: 'symbol-namespace', tone: 'python' },
  rb: { icon: 'symbol-namespace', tone: 'ruby' },
  go: { icon: 'symbol-namespace', tone: 'go' },
  c: { icon: 'file-code', tone: 'code' },
  h: { icon: 'file-code', tone: 'code' },
  cpp: { icon: 'file-code', tone: 'code' },
  cs: { icon: 'file-code', tone: 'code' },
  html: { icon: 'symbol-method', tone: 'html' },
  htm: { icon: 'symbol-method', tone: 'html' },
  css: { icon: 'symbol-color', tone: 'css' },
  scss: { icon: 'symbol-color', tone: 'css' },
  less: { icon: 'symbol-color', tone: 'css' },
  json: { icon: 'json', tone: 'json' },
  jsonc: { icon: 'json', tone: 'json' },
  yaml: { icon: 'symbol-structure', tone: 'yaml' },
  yml: { icon: 'symbol-structure', tone: 'yaml' },
  toml: { icon: 'symbol-structure', tone: 'config' },
  xml: { icon: 'symbol-structure', tone: 'xml' },
  sql: { icon: 'database', tone: 'database' },
  md: { icon: 'markdown', tone: 'markdown' },
  mdx: { icon: 'markdown', tone: 'markdown' },
  markdown: { icon: 'markdown', tone: 'markdown' },
  sh: { icon: 'terminal-bash', tone: 'shell' },
  bash: { icon: 'terminal-bash', tone: 'shell' },
  zsh: { icon: 'terminal', tone: 'shell' },
  ps1: { icon: 'terminal-powershell', tone: 'powershell' },
  bat: { icon: 'terminal-cmd', tone: 'powershell' },
  cmd: { icon: 'terminal-cmd', tone: 'powershell' },
  png: { icon: 'file-media', tone: 'image' },
  jpg: { icon: 'file-media', tone: 'image' },
  jpeg: { icon: 'file-media', tone: 'image' },
  gif: { icon: 'file-media', tone: 'image' },
  webp: { icon: 'file-media', tone: 'image' },
  svg: { icon: 'symbol-color', tone: 'image' },
  txt: { icon: 'file-text', tone: 'text' },
  log: { icon: 'output', tone: 'text' },
};

const FILE_NAME_ICONS: Record<string, { icon: string; tone: string }> = {
  'package.json': { icon: 'json', tone: 'npm' },
  'package-lock.json': { icon: 'lock', tone: 'npm' },
  'cargo.toml': { icon: 'symbol-structure', tone: 'rust' },
  'cargo.lock': { icon: 'lock', tone: 'rust' },
  'dockerfile': { icon: 'server-environment', tone: 'docker' },
  '.gitignore': { icon: 'git-commit', tone: 'git' },
  '.gitattributes': { icon: 'git-commit', tone: 'git' },
  'readme.md': { icon: 'book', tone: 'markdown' },
};

export const codiconResolver: IconResolver = {
  resolve(name: string, isFolder: boolean, isOpen: boolean): IconResult {
    if (isFolder) {
      return {
        type: 'codicon',
        icon: isOpen ? 'folder-opened' : 'folder',
        tone: 'folder',
      };
    }
    const lower = name.toLowerCase();
    const exact = FILE_NAME_ICONS[lower];
    if (exact) return { type: 'codicon', ...exact };

    const parts = lower.split('.');
    for (let index = 1; index < parts.length; index += 1) {
      const match = EXTENSION_ICONS[parts.slice(index).join('.')];
      if (match) return { type: 'codicon', ...match };
    }
    return { type: 'codicon', icon: 'file', tone: 'default' };
  },
};
