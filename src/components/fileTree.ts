import type { FileChange } from '../bindings/generated';

export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[];
  file?: FileChange;
}

export function buildFileTree(files: FileChange[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] };
  for (const file of files) {
    let parent = root;
    const parts = file.path.split('/');
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = parent.children.find((entry) => entry.name === part);
      if (!node) { node = { name: part, path, children: [] }; parent.children.push(node); }
      if (index === parts.length - 1) node.file = file;
      parent = node;
    });
  }
  const sort = (nodes: FileTreeNode[]) => nodes.sort((left, right) => Number(!!left.file) - Number(!!right.file) || left.name.localeCompare(right.name)).forEach((node) => sort(node.children));
  sort(root.children);
  return root.children;
}
