import fs from 'node:fs';

const notesFile = new URL('../src/release-notes.json', import.meta.url);

export function validateReleaseNotes(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('公开更新记录不能为空');
  const versions = new Set();
  for (const entry of entries) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry?.version ?? '')) {
      throw new Error('公开更新记录包含无效版本号');
    }
    if (versions.has(entry.version)) throw new Error(`公开更新记录版本重复：${entry.version}`);
    versions.add(entry.version);
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
      || !Number.isFinite(Date.parse(entry.date)) || new Date(entry.date).toISOString().slice(0, 10) !== entry.date) {
      throw new Error(`公开更新记录日期无效：${entry.version}`);
    }
    for (const language of ['zh-CN', 'en']) {
      const highlights = entry.highlights?.[language];
      if (!Array.isArray(highlights) || !highlights.length
        || highlights.some((text) => typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text))) {
        throw new Error(`公开更新记录缺少有效 ${language} 内容：${entry.version}`);
      }
    }
  }
  return entries;
}

export function releaseNotesForVersion(version, entries = JSON.parse(fs.readFileSync(notesFile, 'utf8'))) {
  const entry = validateReleaseNotes(entries).find((item) => item.version === version);
  if (!entry) throw new Error(`缺少 v${version} 的公开更新记录，请维护 src/release-notes.json`);
  return `VersionDock Desktop v${version}\n\n${entry.highlights['zh-CN'].map((text) => `- ${text.trim()}`).join('\n')}`;
}
