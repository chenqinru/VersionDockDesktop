/**
 * JetBrains 经典风格项目图标色盘
 * 取样自 JetBrains IDE 系列的 Recent Projects 调色体系（高饱和度、高对比度、清晰辨识度）
 */
export const JETBRAINS_PROJECT_COLORS = [
  '#8443D8', // 紫罗兰紫 (如 Jrebel-master)
  '#E85B48', // 珊瑚红橙 (如 api)
  '#3C6CE7', // 宝蓝 (如 k8s-nic)
  '#9046DA', // 紫色 (如 k8s-excellence-star #1)
  '#40806E', // 墨绿/松石绿 (如 k8s-excellence-star #2)
  '#3D8967', // 森林绿 (如 k8s)
  '#A03FD8', // 洋紫 (如 yudao-cloud)
  '#C27F2D', // 琥珀金 (如 Claudix-JetBrains)
  '#2E9F64', // 翡翠绿
  '#E56B40', // 亮橙色
  '#20B2AA', // 青色
  '#E04055', // 玫瑰红
  '#0097A7', // 深湖青
  '#5F6CE5', // 蓝紫色
  '#D97706', // 暖琥珀
  '#C1488C', // 玫红
];

/**
 * 提取项目名的有效英文/字母缩写（匹配 JetBrains 项目图标规则）：
 * 1. 优先按显式分隔符拆分
 * 2. 如果包含 >= 2 个单词：取首词首字符与末词首字符（如 k8s-excellence-star -> KS, Jrebel-master -> JM, Claudix-JetBrains -> CJ）
 * 3. 若只有一个主片段，按驼峰拆分（如 VersionDock -> VD）
 * 4. 如果仅 1 个单词：取首字母（如 api -> A, k8s -> K, nic -> N）
 * 5. 大写输出
 */
export function getProjectInitials(name: string): string {
  if (!name || !name.trim()) return '?';
  const trimmed = name.trim();

  // 1. 优先按显式分隔符（破折号、下划线、空格、点、斜杠）拆分
  const explicitSegments = trimmed.split(/[\s_\-./\\]+/).filter(Boolean);

  if (explicitSegments.length >= 2) {
    const firstWord = explicitSegments[0];
    const lastWord = explicitSegments[explicitSegments.length - 1];
    const firstChar = getLeadingChar(firstWord);
    const lastChar = getLeadingChar(lastWord);
    if (firstChar && lastChar) {
      return (firstChar + lastChar).toUpperCase();
    }
    if (firstChar) {
      return firstChar.toUpperCase();
    }
  }

  // 2. 若只有一个主片段，按驼峰拆分（例如 VersionDock -> ['Version', 'Dock']）
  const singleSegment = explicitSegments.length === 1 ? explicitSegments[0] : trimmed;
  const camelWords = singleSegment
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z\d]+)/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);

  if (camelWords.length >= 2) {
    const firstWord = camelWords[0];
    const lastWord = camelWords[camelWords.length - 1];
    const firstChar = getLeadingChar(firstWord);
    const lastChar = getLeadingChar(lastWord);
    if (firstChar && lastChar) {
      return (firstChar + lastChar).toUpperCase();
    }
    if (firstChar) {
      return firstChar.toUpperCase();
    }
  }

  // 3. 单个词：取首字符（大写）
  const firstWord = camelWords.length ? camelWords[0] : singleSegment;
  const char = getLeadingChar(firstWord);
  if (char) {
    return char.toUpperCase();
  }
  return singleSegment.slice(0, 1).toUpperCase() || '?';
}

function getLeadingChar(word: string): string {
  const match = word.match(/[a-zA-Z0-9\u4e00-\u9fa5]/);
  return match ? match[0] : word.charAt(0);
}

/**
 * 基于字符串（路径或项目名）生成稳定的 JetBrains 色盘颜色
 */
export function getProjectColor(seed: string): string {
  if (!seed) return JETBRAINS_PROJECT_COLORS[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % JETBRAINS_PROJECT_COLORS.length;
  return JETBRAINS_PROJECT_COLORS[index];
}

export type ProjectIconSize = 'small' | 'medium' | 'large' | number;
