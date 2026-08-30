import { describe, expect, it } from 'vitest';
import type { RepositoryStatus } from '../../bindings/generated';
import { resolveSubmoduleOperationTarget } from './submoduleTarget';

const repository = (id: string, rootPath: string, parentRepoId: string | null, isSubmodule: boolean): RepositoryStatus => ({
  meta: { id, name: id, rootPath, color: '#4ec9b0', kind: 'git', parentRepoId, depth: parentRepoId ? 1 : 0, isSubmodule, isWorktree: false },
  branch: 'main', revision: 'abc', ahead: 0, behind: 0, files: [], conflicts: 0, operation: null,
});

describe('BranchMenuPopover submodule contract', () => {
  it('targets the parent repository with a normalized relative gitlink path', () => {
    const parent = repository('parent', 'C:\\work\\project', null, false);
    const submodule = repository('child', 'C:\\work\\project\\vendor\\中文 module', 'parent', true);

    const target = resolveSubmoduleOperationTarget([parent, submodule], 'child');

    expect(target?.parent.meta.id).toBe('parent');
    expect(target?.submodule.meta.id).toBe('child');
    expect(target?.path).toBe('vendor/中文 module');
  });

  it('rejects a submodule root that is not contained by its declared parent', () => {
    const parent = repository('parent', '/workspace/project', null, false);
    const submodule = repository('child', '/workspace/project-other/vendor/module', 'parent', true);
    expect(resolveSubmoduleOperationTarget([parent, submodule], 'child')).toBeUndefined();
  });
});
