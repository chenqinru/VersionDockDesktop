import type { ShelfFileEntry } from '../bindings/generated';

type SavedFile = ShelfFileEntry;
export interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
}
interface TreeFile {
  kind: 'file';
  name: string;
  file: SavedFile;
}
export type TreeNode = TreeDir | TreeFile;

export function buildSavedChangeTree(files: SavedFile[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find(
        (c): c is TreeDir => c.kind === 'dir' && c.name === part,
      );
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return collapseSingleChildDirs(root.children);
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir;
      return {
        kind: 'dir' as const,
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
      };
    }
    return { ...node, children };
  });
}

