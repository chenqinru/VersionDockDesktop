import type { IconResolver, IconResult } from './types';

function svgWrap(content: string, viewBox = '0 0 24 24'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="16" height="16">${content}</svg>`;
}

// Seti / Minimal Colors
const S = {
  blue: '#519aba',
  yellow: '#cbcb41',
  orange: '#e37933',
  red: '#cc3e44',
  green: '#8dc149',
  purple: '#a074c4',
  pink: '#f55385',
  teal: '#4d5a5e',
  grey: '#6d8086',
  white: '#d4d7d6',
  folder: '#8d99ae',
};

const ICONS: Record<string, string> = {
  folder: svgWrap(`<path fill="${S.folder}" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>`),
  folderOpen: svgWrap(`<path fill="${S.blue}" d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/><path fill="${S.folder}" opacity=".3" d="M4 8h16v10H4z"/>`),

  ts: svgWrap(`<path fill="${S.blue}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-3.5 12h-2v4H7v-4H5v-1.5h3.5V14zm7 3.5c-.5.4-1.2.6-1.8.6-.8 0-1.4-.4-1.4-1.1 0-.6.4-1 1.2-1.2.6-.2 1-.3 1-.6 0-.3-.2-.4-.5-.4-.4 0-.8.2-1.2.4l-.5-1.2c.6-.4 1.3-.6 1.9-.6 1.1 0 1.9.6 1.9 1.6 0 .7-.5 1.1-1.3 1.3-.6.2-1 .3-1 .6 0 .3.3.4.6.4.4 0 .8-.2 1.1-.4l.6 1.2zM13 9V3.5L18.5 9H13z"/>`),
  tsx: svgWrap(`<path fill="${S.blue}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-4 15.5l-1.5-2.2-1.5 2.2H5.5l2.2-3.1L5.6 11h1.5l1.4 2.1 1.4-2.1h1.5l-2.1 3.3 2.2 3.2H10zm4-4h2v4h1.5v-4h2V12h-5.5v1.5zM13 9V3.5L18.5 9H13z"/>`),
  js: svgWrap(`<path fill="${S.yellow}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-4.5 15.5c-.4.3-.9.5-1.5.5-1.2 0-1.8-.7-1.8-1.8V13h1.6v3.1c0 .4.2.6.6.6.3 0 .6-.1.8-.3l.3 1.1zm6.5 0c-.5.4-1.2.6-1.8.6-.8 0-1.4-.4-1.4-1.1 0-.6.4-1 1.2-1.2.6-.2 1-.3 1-.6 0-.3-.2-.4-.5-.4-.4 0-.8.2-1.2.4l-.5-1.2c.6-.4 1.3-.6 1.9-.6 1.1 0 1.9.6 1.9 1.6 0 .7-.5 1.1-1.3 1.3-.6.2-1 .3-1 .6 0 .3.3.4.6.4.4 0 .8-.2 1.1-.4l.6 1.2zM13 9V3.5L18.5 9H13z"/>`),
  jsx: svgWrap(`<path fill="${S.yellow}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-5 15.5l-1.5-2.2-1.5 2.2H4.5l2.2-3.1L4.6 11h1.5l1.4 2.1 1.4-2.1h1.5l-2.1 3.3 2.2 3.2H9zm5-3.5c0 .4.2.6.6.6.3 0 .6-.1.8-.3l.3 1.1c-.4.3-.9.5-1.5.5-1.2 0-1.8-.7-1.8-1.8V11h1.6v3.1zM13 9V3.5L18.5 9H13z"/>`),
  vue: svgWrap(`<path fill="${S.green}" d="M2 3h4.5L12 12.5 17.5 3H22L12 20.5 2 3zm4.5 0l5.5 9.5L17.5 3h-3L12 7.5 9.5 3h-3z"/>`),
  svelte: svgWrap(`<path fill="${S.orange}" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm3.5 13.8c-1.8.8-3.9.5-4.8-.8-.6-.9-.3-1.8.5-2.3 1-.6 2.3-.6 3.4-1 .9-.4 1.3-.9 1.1-1.6-.2-.8-1-1.2-2.1-1-1.2.2-2.3.8-3.2 1.5l-.8-1.5c1.2-.9 2.7-1.5 4.3-1.7 2.2-.2 3.6.8 4 2.2.4 1.5-.2 2.7-1.6 3.4-1.1.5-2.3.6-3.4 1-.7.3-1 .7-.8 1.2.2.7.9 1.1 1.9 1 1.1-.1 2.2-.6 3.1-1.2l.4 1.8z"/>`),
  rust: svgWrap(`<path fill="${S.orange}" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5l-2-2.5h-1.5v2.5H8v-9h4c1.7 0 3 1.1 3 2.8 0 1.2-.7 2.2-1.7 2.6l2.2 3.6H13zm-2.5-4.5h1.5c.8 0 1.5-.5 1.5-1.3s-.7-1.3-1.5-1.3h-1.5v2.6z"/>`),
  python: svgWrap(`<path fill="${S.blue}" d="M11.9 2c-3.1 0-2.9 1.3-2.9 1.3l.01 1.4h3v.4H6.2S4 4.8 4 8c0 3.1 1.9 3 1.9 3h1.1v-1.6s-.1-1.9 1.9-1.9h3.3s1.8 0 1.8-1.8V4.8S14.8 2 11.9 2z"/><path fill="${S.yellow}" d="M12.1 22c3.1 0 2.9-1.3 2.9-1.3l-.01-1.4h-3v-.4h5.8s2.2.3 2.2-2.9c0-3.1-1.9-3-1.9-3h-1.1v1.6s.1 1.9-1.9 1.9H11.8s-1.8 0-1.8 1.8v2.9s-.9 2.8 2.1 2.8z"/>`),
  go: svgWrap(`<path fill="${S.blue}" d="M4 10.5c0-2.5 2-4.5 4.5-4.5 1.7 0 3.2 1 3.9 2.5l-1.9.9c-.4-.9-1.2-1.4-2-1.4-1.4 0-2.5 1.1-2.5 2.5s1.1 2.5 2.5 2.5c1 0 1.7-.5 2.1-1.2H8.5v-1.9h4.5v3.4c-1 1.8-2.6 2.7-4.5 2.7C6 17 4 14.5 4 10.5zm11.5 4.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5zm0-2c1.4 0 2.5-1.1 2.5-2.5s-1.1-2.5-2.5-2.5-2.5 1.1-2.5 2.5 1.1 2.5 2.5 2.5z"/>`),
  java: svgWrap(`<path fill="${S.orange}" d="M13 3c-1.5 2-2 3.5 0 5.5-2-2-1-3.5 0-5.5zm-3 3c-1 1.5-1.5 2.5 0 4-1.5-1.5-.5-2.5 0-4zm5.5 5.5c2 1 4 2 2 4.5-1.5 2-5 2.5-8 2.5 5 0 7.5-1 6-7z"/>`),
  c: svgWrap(`<path fill="${S.blue}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm1.5 14c-.6.6-1.5.9-2.5.9-2.2 0-3.8-1.5-3.8-3.7s1.6-3.7 3.8-3.7c1 0 1.9.3 2.5.9l-1 1.2c-.4-.4-.9-.6-1.5-.6-1.3 0-2.2.9-2.2 2.2s.9 2.2 2.2 2.2c.6 0 1.1-.2 1.5-.6l1 1.2zM13 9V3.5L18.5 9H13z"/>`),
  cpp: svgWrap(`<path fill="${S.blue}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 13.5c-.6.5-1.3.8-2.2.8-1.8 0-3-1.2-3-3s1.2-3 3-3c.9 0 1.6.3 2.2.8l-.8 1c-.4-.3-.8-.5-1.4-.5-1 0-1.7.7-1.7 1.7s.7 1.7 1.7 1.7c.6 0 1-.2 1.4-.5l.8 1zm3-1.5h1.5v1.2H16v1.5h-1.2V14h-1.5v-1.2h1.5v-1.5H16V14zm0-3h1.5v1.2H16v1.5h-1.2V11h-1.5V9.8h1.5V8.3H16V11zM13 9V3.5L18.5 9H13z"/>`),
  html: svgWrap(`<path fill="${S.orange}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-4.5 15l-3-3 3-3 1.1 1.1L8.7 14l1.9 1.9-1.1 1.1zm5 0l-1.1-1.1 1.9-1.9-1.9-1.9 1.1-1.1 3 3-3 3zM13 9V3.5L18.5 9H13z"/>`),
  css: svgWrap(`<path fill="${S.blue}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm1.5 15.5l-3.5-1-3.5 1-.8-9h8.6l-.8 9zM13 9V3.5L18.5 9H13z"/>`),
  json: svgWrap(`<path fill="${S.yellow}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-5 13.5c-.5 0-.9-.4-.9-.9v-1.3c0-.5-.4-.9-.9-.9.5 0 .9-.4.9-.9v-1.3c0-.5.4-.9.9-.9h.8v1.2h-.5v1.4c0 .5-.4.9-.9.9.5 0 .9.4.9.9v1.4h.5v1.3H9zm6 0h-.8v-1.3h.5v-1.4c0-.5.4-.9.9-.9-.5 0-.9-.4-.9-.9v-1.4h-.5V10h.8c.5 0 .9.4.9.9v1.3c0 .5.4.9.9.9-.5 0-.9.4-.9.9v1.3c0 .5-.4.9-.9.9zM13 9V3.5L18.5 9H13z"/>`),
  yaml: svgWrap(`<path fill="${S.red}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-4.5 15.5l-2-3.5 1.3-.7 1.4 2.5 2.8-5 1.3.8-3.8 6.9h-1zM13 9V3.5L18.5 9H13z"/>`),
  markdown: svgWrap(`<path fill="${S.blue}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-6 14v-5h1.5l1.5 2 1.5-2H14v5h-1.5v-2.8l-1.5 2-1.5-2V16H8zm8.5-1.5h-1.5v-3.5h1.5V14.5zM13 9V3.5L18.5 9H13z"/>`),
  docker: svgWrap(`<path fill="${S.blue}" d="M21.5 11c-.3 0-1.2.1-1.8.5-.4-.8-1.1-1.3-2-1.4l-.5-.1-.2.5c-.3.8-.2 1.7.3 2.4-1.2.1-5.3.3-7.3 2.1H2.5c-.3.8.2 2.5 1.5 3.5 2.5 2 6.5 2 9.5 2 4.5 0 8-2 8.5-6.5.9-.2 1.5-.9 1.5-1.5 0-.5-.9-1-2-1zM5 12h2v2H5v-2zm3 0h2v2H8v-2zm3 0h2v2h-2v-2zm-3-3h2v2H8V9zm3 0h2v2h-2V9zm3 0h2v2h-2V9zm0 3h2v2h-2v-2zm3-3h2v2h-2V9zm0 3h2v2h-2v-2z"/>`),
  git: svgWrap(`<path fill="${S.orange}" d="M21.7 10.7l-8.4-8.4c-.9-.9-2.5-.9-3.4 0L7.6 4.6l3.3 3.3c.8-.3 1.7-.1 2.3.5.6.6.8 1.5.5 2.3l3.2 3.2c.8-.3 1.7-.1 2.3.5.9.9.9 2.5 0 3.4-.9.9-2.5.9-3.4 0-.7-.7-.9-1.7-.5-2.5l-3-3v4.6c.4.3.7.8.7 1.4 0 1.1-.9 2-2 2s-2-.9-2-2c0-.6.3-1.1.7-1.4V9.6c-.4-.3-.7-.8-.7-1.4 0-.8.5-1.5 1.2-1.8L6.2 3.2 2.3 7.1c-.9.9-.9 2.5 0 3.4l8.4 8.4c.9.9 2.5.9 3.4 0l7.6-7.6c.9-.9.9-2.4 0-3.6z"/>`),
  lock: svgWrap(`<path fill="${S.yellow}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-2 15c-1.7 0-3-1.3-3-3 0-1.3.8-2.4 2-2.8V11c0-.6.4-1 1-1s1 .4 1 1v2.2c1.2.4 2 1.5 2 2.8 0 1.7-1.3 3-3 3zM13 9V3.5L18.5 9H13z"/>`),
  terminal: svgWrap(`<path fill="${S.green}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-6 13l3-3-3-3 1.2-1.2 4.2 4.2-4.2 4.2L8 15zm5 2h5v1.5h-5V17zM13 9V3.5L18.5 9H13z"/>`),
  image: svgWrap(`<path fill="${S.purple}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-6 16l3-4 2 2.5 3-4 3 5.5H8zM13 9V3.5L18.5 9H13z"/>`),
  config: svgWrap(`<path fill="${S.grey}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-2 15.5c-2 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zM13 9V3.5L18.5 9H13z"/>`),
  file: svgWrap(`<path fill="${S.grey}" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>`),
};

const EXTENSION_MAP: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  vue: 'vue', svelte: 'svelte',
  rs: 'rust', py: 'python', pyc: 'python', go: 'go',
  java: 'java', kt: 'java', kts: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'c',
  php: 'purple', rb: 'red',
  html: 'html', htm: 'html', css: 'css', scss: 'css', sass: 'css', less: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'config', ini: 'config', env: 'config',
  xml: 'html', sql: 'purple',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal', fish: 'terminal', ps1: 'terminal', bat: 'terminal', cmd: 'terminal',
  dockerfile: 'docker',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image',
  lock: 'lock',
  txt: 'file', log: 'file',
};

const EXACT_FILE_MAP: Record<string, string> = {
  'package.json': 'json',
  'package-lock.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  'cargo.toml': 'rust',
  'cargo.lock': 'lock',
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'readme.md': 'markdown',
  'license': 'config',
  'license.md': 'config',
  'tsconfig.json': 'ts',
  'vite.config.ts': 'ts',
  'vite.config.js': 'js',
};

export const setiResolver: IconResolver = {
  resolve(name: string, isFolder: boolean, isOpen: boolean): IconResult {
    if (isFolder) {
      return { type: 'svg', svg: isOpen ? ICONS.folderOpen : ICONS.folder };
    }
    const lower = name.toLowerCase();
    const exact = EXACT_FILE_MAP[lower];
    if (exact && ICONS[exact]) {
      return { type: 'svg', svg: ICONS[exact] };
    }

    const parts = lower.split('.');
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join('.');
      const match = EXTENSION_MAP[ext];
      if (match && ICONS[match]) {
        return { type: 'svg', svg: ICONS[match] };
      }
    }

    return { type: 'svg', svg: ICONS.file };
  },
};
