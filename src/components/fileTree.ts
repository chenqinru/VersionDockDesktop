import type { FileChange } from '../bindings/generated';

interface TreeFile { path: string; isTruncated?: boolean; }

export interface FileTreeNode<T extends TreeFile = FileChange> {
  name: string;
  path: string;
  children: FileTreeNode<T>[];
  files: T[];
  file?: T;
}

export function buildFileTree<T extends TreeFile>(files: T[]): FileTreeNode<T>[] {
  const root: FileTreeNode<T> = { name: '', path: '', children: [], files: [] };
  for (const file of files) {
    let parent = root;
    root.files.push(file);
    const parts = file.path.split('/');
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let node = parent.children.find((entry) => entry.name === part);
      if (!node) { node = { name: part, path, children: [], files: [] }; parent.children.push(node); }
      node.files.push(file);
      if (index === parts.length - 1) node.file = file;
      parent = node;
    });
  }
  const exposeTruncatedDirectory = (nodes: FileTreeNode<T>[]) => {
    for (const node of nodes) {
      if (node.file?.isTruncated && node.children.length > 0) {
        const marker = node.file;
        node.file = undefined;
        node.children.push({ name: node.name, path: `${node.path}\0truncated`, children: [], files: [marker], file: marker });
      }
      exposeTruncatedDirectory(node.children);
    }
  };
  exposeTruncatedDirectory(root.children);
  const sort = (nodes: FileTreeNode<T>[]) => nodes.sort((left, right) => Number(!!left.file) - Number(!!right.file) || left.name.localeCompare(right.name)).forEach((node) => sort(node.children));
  sort(root.children);
  return collapseSingleChildDirectories(root.children);
}

function collapseSingleChildDirectories<T extends TreeFile>(nodes: FileTreeNode<T>[]): FileTreeNode<T>[] {
  return nodes.map((node) => {
    if (node.file) return node;
    const children = collapseSingleChildDirectories(node.children);
    if (children.length === 1 && !children[0].file) {
      const child = children[0];
      return { ...child, name: `${node.name}/${child.name}`, files: node.files };
    }
    return { ...node, children };
  });
}
