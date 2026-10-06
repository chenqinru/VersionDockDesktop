import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import type { BundledLanguage } from 'shiki/types';
import darkPlus from 'shiki/themes/dark-plus.mjs';
import lightPlus from 'shiki/themes/light-plus.mjs';
import githubDimmed from 'shiki/themes/github-dark-dimmed.mjs';
import oneDarkPro from 'shiki/themes/one-dark-pro.mjs';
import dracula from 'shiki/themes/dracula.mjs';
import nord from 'shiki/themes/nord.mjs';
import { theme2026Dark, theme2026Light } from '../theme/shiki2026';

// 显式列出应用支持的语言，让打包器只收录这些语言及其嵌入语法。
const loaders = {
  astro: () => import('shiki/langs/astro.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sass: () => import('shiki/langs/sass.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shell: () => import('shiki/langs/shell.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

type SupportedLanguage = keyof typeof loaders;
const aliases: Record<string, SupportedLanguage> = {
  js: 'javascript', cjs: 'javascript', mjs: 'javascript',
  ts: 'typescript', cts: 'typescript', mts: 'typescript',
  'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', kt: 'kotlin', kts: 'kotlin',
  md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', yml: 'yaml',
  bash: 'shell', sh: 'shell', zsh: 'shell', shellscript: 'shell',
};

let instance: HighlighterCore | null = null;
let initialization: Promise<HighlighterCore> | null = null;
const languageLoads = new Map<SupportedLanguage, Promise<void>>();

export function resolveHighlightLanguage(language: string): BundledLanguage | null {
  const key = language.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(loaders, key)) return key as SupportedLanguage;
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : null;
}

export function cachedHighlighter(language: string): HighlighterCore | null {
  const resolved = resolveHighlightLanguage(language);
  return instance && (!resolved || instance.getLoadedLanguages().includes(resolved)) ? instance : null;
}

export async function ensureHighlighter(language: string): Promise<HighlighterCore> {
  if (!initialization) {
    initialization = createHighlighterCore({
      themes: [theme2026Dark, theme2026Light, darkPlus, lightPlus, githubDimmed, oneDarkPro, dracula, nord],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).then((value) => {
      instance = value;
      return value;
    }).catch((error) => {
      initialization = null;
      throw error;
    });
  }
  const highlighter = await initialization;
  const resolved = resolveHighlightLanguage(language) as SupportedLanguage | null;
  if (resolved && !highlighter.getLoadedLanguages().includes(resolved)) {
    let loading = languageLoads.get(resolved);
    if (!loading) {
      loading = loaders[resolved]().then((module) => highlighter.loadLanguage(...module.default)).catch((error) => {
        languageLoads.delete(resolved);
        throw error;
      });
      languageLoads.set(resolved, loading);
    }
    await loading;
  }
  return highlighter;
}
