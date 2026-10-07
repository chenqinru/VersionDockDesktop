#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockJsonPath = path.join(rootDir, 'package-lock.json');
const tauriConfPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(rootDir, 'src-tauri', 'Cargo.lock');

// ANSI 颜色输出辅助函数
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function parseSemver(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || undefined,
  };
}

function getBumpOptions(currentVersion) {
  const parsed = parseSemver(currentVersion);
  if (!parsed) return null;
  return {
    patch: `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`,
    minor: `${parsed.major}.${parsed.minor + 1}.0`,
    major: `${parsed.major + 1}.0.0`,
  };
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function resolveTargetVersion(currentVersion) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const options = getBumpOptions(currentVersion);

  if (args.length > 0) {
    const input = args[0].toLowerCase();
    if (options && input === 'patch') return options.patch;
    if (options && input === 'minor') return options.minor;
    if (options && input === 'major') return options.major;
    if (parseSemver(args[0])) return args[0];

    console.error(`${colors.red}❌ 无效的版本号格式: "${args[0]}" (需符合 SemVer 规范，例如 1.2.3 或 1.2.3-beta.1)${colors.reset}`);
    process.exit(1);
  }

  console.log(`\n${colors.cyan}${colors.bright}📦 VersionDock Desktop 版本更新工具${colors.reset}`);
  console.log(`${colors.gray}当前版本:${colors.reset} ${colors.yellow}${colors.bright}${currentVersion}${colors.reset}\n`);

  if (options) {
    console.log(`${colors.bright}快捷升级选项:${colors.reset}`);
    console.log(`  ${colors.green}1) patch${colors.reset} -> ${colors.cyan}${options.patch}${colors.reset}`);
    console.log(`  ${colors.green}2) minor${colors.reset} -> ${colors.cyan}${options.minor}${colors.reset}`);
    console.log(`  ${colors.green}3) major${colors.reset} -> ${colors.cyan}${options.major}${colors.reset}`);
    console.log(`  ${colors.gray}或直接输入具体版本号 (如 0.2.0, 1.0.0-beta.1)${colors.reset}\n`);
  }

  const input = await askQuestion(`${colors.bright}请输入目标版本号或选项 (1/2/3): ${colors.reset}`);
  if (!input) {
    console.log(`${colors.gray}操作已取消${colors.reset}`);
    process.exit(0);
  }

  if (options) {
    if (input === '1' || input.toLowerCase() === 'patch') return options.patch;
    if (input === '2' || input.toLowerCase() === 'minor') return options.minor;
    if (input === '3' || input.toLowerCase() === 'major') return options.major;
  }

  if (parseSemver(input)) return input;

  console.error(`\n${colors.red}❌ 无效的版本号格式: "${input}"${colors.reset}`);
  process.exit(1);
}

function updateCargoToml(content, newVersion) {
  const lines = content.split('\n');
  let inPackageSection = false;
  let replaced = false;

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inPackageSection = trimmed === '[package]';
    } else if (inPackageSection && !replaced && /^version\s*=\s*"[^"]+"/.test(trimmed)) {
      replaced = true;
      return line.replace(/(version\s*=\s*)"[^"]+"/, `$1"${newVersion}"`);
    }
    return line;
  });

  return newLines.join('\n');
}

function updateFiles(currentVersion, newVersion) {
  const updatedFiles = [];

  // 1. 更新 package.json (精确替换 version 字段)
  if (fs.existsSync(packageJsonPath)) {
    let pkgContent = fs.readFileSync(packageJsonPath, 'utf8');
    const pkgVersionPattern = /("version"\s*:\s*)"([^"]+)"/;
    if (pkgVersionPattern.test(pkgContent)) {
      pkgContent = pkgContent.replace(pkgVersionPattern, `$1"${newVersion}"`);
      fs.writeFileSync(packageJsonPath, pkgContent, 'utf8');
      updatedFiles.push('package.json');
    }
  }

  // 2. 更新 package-lock.json (精确替换前两个顶层与自身 package 的 version 字段)
  if (fs.existsSync(packageLockJsonPath)) {
    let lockContent = fs.readFileSync(packageLockJsonPath, 'utf8');
    let replacedCount = 0;
    lockContent = lockContent.replace(/("version"\s*:\s*)"([^"]+)"/g, (match, prefix, oldVer) => {
      if (replacedCount < 2 && oldVer === currentVersion) {
        replacedCount++;
        return `${prefix}"${newVersion}"`;
      }
      return match;
    });
    fs.writeFileSync(packageLockJsonPath, lockContent, 'utf8');
    updatedFiles.push('package-lock.json');
  }

  // 3. 更新 src-tauri/tauri.conf.json
  if (fs.existsSync(tauriConfPath)) {
    let tauriContent = fs.readFileSync(tauriConfPath, 'utf8');
    const tauriVersionPattern = /("version"\s*:\s*)"([^"]+)"/;
    if (tauriVersionPattern.test(tauriContent)) {
      tauriContent = tauriContent.replace(tauriVersionPattern, `$1"${newVersion}"`);
      fs.writeFileSync(tauriConfPath, tauriContent, 'utf8');
      updatedFiles.push('src-tauri/tauri.conf.json');
    }
  }

  // 4. 更新 src-tauri/Cargo.toml
  if (fs.existsSync(cargoTomlPath)) {
    const cargoContent = fs.readFileSync(cargoTomlPath, 'utf8');
    const updatedCargo = updateCargoToml(cargoContent, newVersion);
    if (updatedCargo !== cargoContent) {
      fs.writeFileSync(cargoTomlPath, updatedCargo, 'utf8');
      updatedFiles.push('src-tauri/Cargo.toml');
    }
  }

  // 5. 更新 Cargo.lock 中当前应用包的版本，保证 CI 可以使用 --locked。
  if (fs.existsSync(cargoLockPath)) {
    let cargoLockContent = fs.readFileSync(cargoLockPath, 'utf8');
    const packagePattern = /(\[\[package\]\]\s+name\s*=\s*"versiondock-desktop"\s+version\s*=\s*")([^"]+)(")/;
    if (packagePattern.test(cargoLockContent)) {
      cargoLockContent = cargoLockContent.replace(packagePattern, `$1${newVersion}$3`);
      fs.writeFileSync(cargoLockPath, cargoLockContent, 'utf8');
      updatedFiles.push('src-tauri/Cargo.lock');
    }
  }

  return updatedFiles;
}

async function main() {
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`${colors.red}❌ 未找到 package.json 文件${colors.reset}`);
    process.exit(1);
  }

  const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const currentVersion = pkgJson.version;

  const newVersion = await resolveTargetVersion(currentVersion);

  if (newVersion === currentVersion) {
    console.log(`\n${colors.yellow}⚠️ 目标版本号 (${newVersion}) 与当前版本一致，无需修改。${colors.reset}`);
    return;
  }

  const updatedFiles = updateFiles(currentVersion, newVersion);

  console.log(`\n${colors.green}${colors.bright}✅ 版本更新成功！${colors.reset}`);
  console.log(`   ${colors.yellow}${currentVersion}${colors.reset} ➜ ${colors.green}${colors.bright}${newVersion}${colors.reset}\n`);

  console.log(`${colors.bright}已更新文件:${colors.reset}`);
  updatedFiles.forEach((file) => {
    console.log(`  ${colors.cyan}• ${file}${colors.reset}`);
  });
  console.log(`\n${colors.yellow}请在 src/release-notes.json 添加 ${newVersion} 的公开更新内容（中英文）。${colors.reset}`);

  console.log(`\n${colors.gray}接下来你可以运行:${colors.reset}`);
  console.log(`  ${colors.blue}npm run check${colors.reset}        ${colors.gray}# 执行完整静态检查与测试${colors.reset}`);
  console.log(`  ${colors.blue}npm run tauri:build${colors.reset}  ${colors.gray}# 打包桌面应用安装包${colors.reset}`);
  console.log(`  ${colors.blue}git commit -am "chore: bump version to ${newVersion}"${colors.reset}\n`);
}

main().catch((err) => {
  console.error(`${colors.red}❌ 执行失败: ${err.message}${colors.reset}`);
  process.exit(1);
});
