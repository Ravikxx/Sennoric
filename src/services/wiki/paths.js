import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { isTrustedDirectory } from '../../persist.js';

const GLOBAL_WIKI_ROOT = join(homedir(), '.sennoric', 'wiki');
const LOCAL_WIKI_DIR   = '.sennoric';

export function getWikiRoot(projectPath) {
  if (projectPath && isTrustedDirectory(projectPath)) {
    const local = join(projectPath, LOCAL_WIKI_DIR, 'wiki');
    if (existsSync(local)) return local;
  }
  return GLOBAL_WIKI_ROOT;
}

export function ensureWikiDirs(projectPath) {
  const root = getWikiRoot(projectPath);
  for (const sub of ['', 'pages', 'sources']) {
    const dir = join(root, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return root;
}

export function pagePath(root, title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled';
  return join(root, 'pages', `${slug}.md`);
}

export function sourcePath(root, sourceFile) {
  const slug = sourceFile.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
  return join(root, 'sources', `${slug}.md`);
}

export function indexPath(root) {
  return join(root, 'index.md');
}

export function logPath(root) {
  return join(root, 'log.md');
}
