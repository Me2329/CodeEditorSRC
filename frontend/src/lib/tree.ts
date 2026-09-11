/**
 * Paths into a tree.
 *
 * Files in this workspace are named, not nested: `lib/util.py` is a name with a
 * slash in it, and the explorer showed exactly that, one flat row per file. It
 * worked for the six files a demo has and stopped working the moment anyone
 * organised anything.
 *
 * The tree is derived rather than stored. Folders have no identity of their
 * own: they exist because a file is named as being inside one, and they stop
 * existing when the last such file is deleted. That is the right model for a
 * workspace where the file list is the truth, and it means renaming a file into
 * another folder is a rename rather than a move operation nobody wrote.
 *
 * The cost is that an empty folder cannot exist, which is a real limitation and
 * the reason this is written down.
 */

import type { VirtualFile } from './types';

export interface TreeFile {
  kind: 'file';
  /** The last segment, which is what the row shows. */
  name: string;
  /** The full path, which is the file's name. */
  path: string;
  file: VirtualFile;
}

export interface TreeFolder {
  kind: 'folder';
  name: string;
  /** The path of the folder itself, for remembering which are collapsed. */
  path: string;
  children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

/**
 * Folders first, then files, each alphabetically.
 *
 * Numeric-aware, so `part2.py` sorts before `part10.py` the way a person
 * reading a list expects rather than the way bytes compare.
 */
function compare(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort(compare);
  for (const node of nodes) {
    if (node.kind === 'folder') sortTree(node.children);
  }
  return nodes;
}

/** Build the tree a list of named files implies. */
export function buildTree(files: readonly VirtualFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  // Folders by path, so the second file in a folder finds the first one's.
  const folders = new Map<string, TreeFolder>();

  for (const file of files) {
    const segments = file.name.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (!fileName) continue;

    let siblings = root;
    let path = '';

    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      let folder = folders.get(path);
      if (!folder) {
        folder = { kind: 'folder', name: segment, path, children: [] };
        folders.set(path, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }

    siblings.push({ kind: 'file', name: fileName, path: file.name, file });
  }

  return sortTree(root);
}

export interface Row {
  node: TreeNode;
  /** How far in to indent, counted in folders. */
  depth: number;
}

/**
 * The tree as rows to render, with collapsed folders hiding their contents.
 *
 * Flattened here rather than rendered recursively so that keyboard navigation
 * and virtualisation, if either arrives, work on a list rather than a shape.
 */
export function flatten(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string> = new Set(),
  depth = 0,
): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === 'folder' && !collapsed.has(node.path)) {
      rows.push(...flatten(node.children, collapsed, depth + 1));
    }
  }
  return rows;
}

/** Every folder in the tree, which is what "collapse all" needs. */
export function folderPaths(nodes: readonly TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'folder') {
      paths.push(node.path);
      paths.push(...folderPaths(node.children));
    }
  }
  return paths;
}

/** Collapse a folder, or open it. */
export function toggle(collapsed: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(collapsed);
  if (!next.delete(path)) next.add(path);
  return next;
}

/**
 * The folders a path sits inside, outermost first.
 *
 * Used to open the way to a file that was revealed from somewhere else: showing
 * a search hit in a collapsed folder should open the folder.
 */
export function ancestors(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  segments.pop();
  const result: string[] = [];
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    result.push(current);
  }
  return result;
}

/** Open every folder on the way to a path. */
export function reveal(collapsed: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(collapsed);
  for (const folder of ancestors(path)) next.delete(folder);
  return next;
}
