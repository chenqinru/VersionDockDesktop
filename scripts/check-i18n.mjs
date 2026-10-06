import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;
const sourceRoots = [join(root, 'src', 'App.tsx'), join(root, 'src', 'components')];
const technicalAllowlist = new Set([
  'VersionDock', 'VersionDock Desktop', 'Git & SVN', 'Git:', 'SVN:', 'HEAD',
  'Promise', 'https://gitlab.com', 'glpat-...', 'my-repo',
]);

function files(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

const violations = [];

// Backend operation text reaches React through events, so scanning JSX alone misses it.
function quotedStrings(source) {
  return [...source.matchAll(/"(?:\\.|[^"\\])*"/g)].map((match) => JSON.parse(match[0]));
}

function balancedSection(source, start, opening, closing) {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted && character === '\\') { index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === opening) depth += 1;
    if (character === closing && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('Unbalanced native operation declaration');
}

const i18nPath = join(root, 'src/i18n/index.tsx');
const i18nSource = ts.createSourceFile(i18nPath, readFileSync(i18nPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const catalogs = {};
for (const statement of i18nSource.statements) {
  if (!ts.isVariableStatement(statement)) continue;
  for (const declaration of statement.declarationList.declarations) {
    const name = declaration.name.getText(i18nSource);
    if (!['desktopEn', 'desktopZh'].includes(name) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
    catalogs[name] = new Map(declaration.initializer.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) && ts.isStringLiteral(property.initializer)
        ? [[property.name.text, property.initializer.text]] : []));
  }
}

const nativeMessages = new Set();
// Calling t() is not enough if the built-in catalogs lack the requested key.
for (const path of ['src/components/AboutDialog.tsx', 'src/components/StatusBar/UpdateStatusBarItem.tsx']) {
  const source = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visitUpdateText(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const message = node.arguments[0].text;
      if (!catalogs.desktopEn.has(message) || !catalogs.desktopZh.has(message)) {
        violations.push(`About/update text requires built-in English and Chinese translations: ${message}`);
      }
    }
    ts.forEachChild(node, visitUpdateText);
  }
  visitUpdateText(source);
}

for (const path of ['src-tauri/src/commands.rs', 'src-tauri/src/state.rs']) {
  const source = readFileSync(join(root, path), 'utf8');
  for (const match of source.matchAll(/\b(?:emit_operation_phase|emit_current_operation)\s*\(/g)) {
    const start = match.index + match[0].lastIndexOf('(');
    quotedStrings(balancedSection(source, start, '(', ')')).forEach((message) => nativeMessages.add(message));
  }
  for (const match of source.matchAll(/\bfn\s+(?:command_progress|sync_phase|svn_phase|submodule_phase|subtree_phase)\s*\(/g)) {
    const start = source.indexOf('{', match.index);
    const body = balancedSection(source, start, '{', '}');
    for (const tuple of body.matchAll(/\(\s*"[^"\n]+"\s*,\s*("(?:\\.|[^"\\])*")/g)) nativeMessages.add(JSON.parse(tuple[1]));
  }
  for (const match of source.matchAll(/message:\s*("(?:\\.|[^"\\])*")\.into\(\)/g)) nativeMessages.add(JSON.parse(match[1]));
}
for (const message of [...nativeMessages].filter((text) => /^[A-Z].*\s/.test(text))) {
  if (!catalogs.desktopEn.has(message) || !catalogs.desktopZh.has(message) || catalogs.desktopZh.get(message) === message) {
    violations.push(`Native operation message requires built-in English and Chinese translations: ${message}`);
  }
}

// Notifications can be shown before the asynchronously loaded plugin bundle arrives.
const notificationMessages = new Set();
const storePath = join(root, 'src/store/appStore.ts');
const storeSource = ts.createSourceFile(storePath, readFileSync(storePath, 'utf8'), ts.ScriptTarget.Latest, true);
function staticNotificationText(node) {
  if (ts.isStringLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...staticNotificationText(node.whenTrue), ...staticNotificationText(node.whenFalse)];
  if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap((property) =>
    ts.isPropertyAssignment(property) && property.name.getText(storeSource) === 'key' ? staticNotificationText(property.initializer) : []);
  return [];
}
function visitNotificationText(node) {
  if (ts.isPropertyAssignment(node) && ['title', 'label', 'message', 'key'].includes(node.name.getText(storeSource))) {
    staticNotificationText(node.initializer).forEach((message) => notificationMessages.add(message));
  }
  if (ts.isCallExpression(node) && node.expression.getText(storeSource) === 'publishError' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) notificationMessages.add(node.arguments[0].text);
  ts.forEachChild(node, visitNotificationText);
}
visitNotificationText(storeSource);
for (const message of notificationMessages) {
  if (!/[A-Z]/.test(message) || technicalAllowlist.has(message) || ['Git', 'SVN'].includes(message)) continue;
  if (!catalogs.desktopEn.has(message) || !catalogs.desktopZh.has(message)) violations.push(`Notification requires built-in English and Chinese translations: ${message}`);
}
for (const file of sourceRoots.flatMap(files).filter((path) => path.endsWith('.tsx') && !path.endsWith('.test.tsx'))) {
  const source = readFileSync(file, 'utf8');
  const patterns = [
    /(?:aria-label|title|placeholder)="([^"{]*[A-Za-z][^"]*)"/g,
    />\s*([A-Z][A-Za-z0-9 &:+.()-]{2,})\s*</g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const text = match[1].trim();
      if (technicalAllowlist.has(text)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${relative(root, file)}:${line}: ${text}`);
    }
  }
}

if (violations.length) {
  console.error('Visible English text must use the shared translator:\n' + violations.join('\n'));
  process.exit(1);
}
console.log(`Visible text and ${[...nativeMessages].filter((text) => /^[A-Z].*\s/.test(text)).length} native operation translations passed.`);
