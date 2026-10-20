import { useEffect, useRef, useState } from 'react';
import type { CheckpointCatalog, CheckpointProject, TaskWorkspace, WorkspaceDescriptor } from '../bindings/generated';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n';
import { closeCheckpointCenter, useCheckpointCenter } from '../checkpoints/center';
import { checkpointWorkspaceChanged, refreshCheckpoints, selectCheckpointTask, useCheckpointStore } from '../checkpoints/store';
import { CheckpointPanel } from './CheckpointPanel';
import { SearchInput } from './SearchInput';
import { Button } from './Button';
import { FormField } from './FormField';
import { Select } from './Select';
import { IconButton } from './IconButton';
import { Codicon } from './Codicon';
import { ErrorNotice } from './ErrorNotice';
import { EmptyState } from './EmptyState';
import { LoadingState } from './LoadingState';
import { ProjectIcon } from './ProjectIcon';

function taskStatus(task: TaskWorkspace) {
  if (task.error || task.hookError || task.checkpoints.some(point => point.status === 'incomplete')) return 'Checkpoint problem';
  if (task.checkpoints.some(point => point.status === 'recording')) return 'Checkpoint status: recording';
  if (task.checkpoints.some(point => point.status === 'interrupted')) return 'Needs finishing';
  return task.checkpoints.length ? `Checkpoint status: ${task.checkpoints.at(-1)!.status}` : 'Ready to record';
}

export function CheckpointCenterHost() {
  const open = useCheckpointCenter(state => state.open);
  return open ? <CheckpointCenter /> : null;
}

function CheckpointCenter() {
  const { t } = useI18n();
  const bridge = useAppStore(state => state.bridge);
  const snapshot = useAppStore(state => state.snapshot);
  const recentProjects = useAppStore(state => state.bootstrap?.state.recentWorkspaces);
  const request = useCheckpointCenter();
  const scope = useCheckpointStore();
  const initialTask = useRef(request.taskId);
  const [catalog, setCatalog] = useState<CheckpointCatalog>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(request.projectId ?? snapshot?.workspace.id);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [repositories, setRepositories] = useState<{ id: string; data?: CheckpointProject; error?: string }>();
  const [localProjects, setLocalProjects] = useState<WorkspaceDescriptor[]>([]);
  const [creationActive, setCreationActive] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string>();
  const [repositoryRetry, setRepositoryRetry] = useState(0);
  const pickerTicket = useRef(0);
  const pickerController = useRef<AbortController>();
  const availableProjects = [...new Map([...(catalog?.projects ?? []), ...(recentProjects ?? []), ...(snapshot ? [snapshot.workspace] : []), ...localProjects].map(project => [project.id, project])).values()];
  const project = availableProjects.find(project => project.id === selected) ?? catalog?.projects[0] ?? availableProjects[0];
  const projectId = project?.id;
  const preparedProject = repositories?.id === projectId ? repositories?.data : undefined;
  const projectRepositories = preparedProject?.repositories.map(meta => ({ meta })) ?? [];
  const projectLoading = creationActive && (picking || Boolean(projectId && repositories?.id !== projectId));

  useEffect(() => {
    if (!bridge) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || useCheckpointStore.getState().busy) return;
      pending = true;
      try {
        const catalog = await bridge.request<CheckpointCatalog>({ type: 'checkpointCatalog' }, { signal: controller.signal, showProgress: false });
        if (!Array.isArray(catalog.projects) || !Array.isArray(catalog.tasks)) throw new Error('History is unavailable');
        if (!controller.signal.aborted) { setCatalog(catalog); setError(undefined); }
        const state = useCheckpointStore.getState();
        if (!controller.signal.aborted && state.workspaceId && !state.details && !state.preview) void refreshCheckpoints();
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [bridge, retry]);

  useEffect(() => {
    if (!creationActive || !projectId || !bridge) return;
    const controller = new AbortController();
    void bridge.request<CheckpointProject>({ type: 'checkpointProject', payload: { workspace_id: projectId, paths: [] } }, { signal: controller.signal, showProgress: false, context: { workspaceId: projectId } }).then(data => {
      if (!data.workspace || !Array.isArray(data.repositories) || !Array.isArray(data.tasks)) throw new Error('History is unavailable');
      if (!controller.signal.aborted) setRepositories({ id: projectId, data });
    }).catch(error => { if (!controller.signal.aborted) setRepositories({ id: projectId, error: String(error) }); });
    return () => controller.abort();
  }, [bridge, projectId, repositoryRetry, creationActive]);
  useEffect(() => () => checkpointWorkspaceChanged(null), []);
  useEffect(() => () => { pickerTicket.current += 1; pickerController.current?.abort(); }, []);
  useEffect(() => {
    if (initialTask.current && scope.listing?.tasks.some(task => task.id === initialTask.current)) { selectCheckpointTask(initialTask.current); initialTask.current = undefined; }
  }, [scope.listing]);

  const hasMatches = catalog?.projects.some(group => group.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || catalog.tasks.some(task => task.workspaceId === group.id && task.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const choose = (project: WorkspaceDescriptor, task?: TaskWorkspace) => {
    if (scope.busy || picking) return;
    checkpointWorkspaceChanged(project.id, true);
    if (task) selectCheckpointTask(task.id);
    setSelected(project.id);
    setExpanded(previous => ({ ...previous, [project.id]: true }));
  };
  const navigation = (newTask: () => void, blocked: boolean, showTask: () => void) => <aside className="settings-sidebar checkpoint-sidebar checkpoint-center-sidebar">
    <div className="checkpoint-sidebar-heading"><strong>{t('Projects')}</strong><span>{catalog?.projects.length ?? 0}</span><IconButton title={t('New checkpoint task')} disabled={blocked || picking} onClick={newTask}><Codicon name="add" /></IconButton></div>
    <SearchInput aria-label={t('Search projects and tasks')} value={query} placeholder={t('Search projects and tasks')} onChange={event => setQuery(event.target.value)} onClear={() => setQuery('')} />
    <nav className="checkpoint-center-projects" aria-label={t('Checkpoint projects')}>
      {!catalog && !error && <LoadingState>{t('Loading…')}</LoadingState>}
      {error && <ErrorNotice onRetry={() => setRetry(value => value + 1)}>{t(error)}</ErrorNotice>}
      {catalog?.projects.map(group => {
        const tasks = catalog.tasks.filter(task => task.workspaceId === group.id);
        const search = query.trim().toLocaleLowerCase();
        const matching = group.name.toLocaleLowerCase().includes(search) ? tasks : tasks.filter(task => task.name.toLocaleLowerCase().includes(search));
        if (!matching.length) return null;
        const open = Boolean(search) || (expanded[group.id] ?? group.id === projectId);
        return <section className="checkpoint-project" key={group.id}>
          <button type="button" className="checkpoint-project-heading vd-selectable" aria-expanded={open} disabled={scope.busy || picking} title={group.paths.join('\n')} onClick={() => setExpanded(previous => ({ ...previous, [group.id]: !open }))}>
            <Codicon name={open ? 'chevron-down' : 'chevron-right'} /><ProjectIcon name={group.name} seed={group.paths[0] || group.id || group.name} size="small" available={group.available} /><strong>{group.name}</strong><span>{tasks.length}</span>
          </button>
          {open && matching.map(task => <button type="button" key={task.id} className="checkpoint-center-task vd-selectable" aria-pressed={scope.selectedTaskId === task.id && projectId === group.id} disabled={scope.busy || picking} onClick={() => { choose(group, task); showTask(); }}>
            <span title={task.name}>{task.name}</span><small data-status={task.checkpoints.some(point => point.status === 'recording') ? 'recording' : undefined}>{t(taskStatus(task))}</small>
          </button>)}
        </section>;
      })}
      {catalog && catalog.tasks.length > 0 && !hasMatches && <EmptyState compact icon="search">{t('No results')}</EmptyState>}
      {catalog && !catalog.tasks.length && <EmptyState compact icon="checkpoint">{t('No checkpoint tasks yet')}</EmptyState>}
    </nav>
  </aside>;
  const browse = async () => {
    if (!bridge || scope.busy || picking) return;
    const ticket = ++pickerTicket.current;
    const controller = new AbortController(); pickerController.current = controller;
    setPicking(true); setPickerError(undefined);
    try {
      const path = await bridge.selectDirectory(t('Select project folder'));
      if (!path || ticket !== pickerTicket.current) return;
      const data = await bridge.request<CheckpointProject>({ type: 'checkpointProject', payload: { workspace_id: null, paths: [path] } }, { signal: controller.signal, showProgress: false });
      if (ticket !== pickerTicket.current) return;
      if (!data.workspace || !Array.isArray(data.repositories) || !Array.isArray(data.tasks)) throw new Error('History is unavailable');
      setLocalProjects(previous => [...previous.filter(project => project.id !== data.workspace.id), data.workspace]);
      setRepositories({ id: data.workspace.id, data }); setSelected(data.workspace.id);
    } catch (error) { if (ticket === pickerTicket.current) setPickerError(error instanceof Error ? error.message : String(error)); }
    finally { if (ticket === pickerTicket.current) { pickerController.current = undefined; setPicking(false); } }
  };
  const projectSelection = <>
    <FormField label={t('Task project')} required>
      <div className="checkpoint-project-picker">
        <Select value={projectId ?? ''} disabled={scope.busy || picking} options={availableProjects.length ? availableProjects.map(project => ({ value: project.id, label: project.name })) : [{ value: '', label: t('Select a project'), disabled: true }]} onChange={value => { setPickerError(undefined); setSelected(value); }} />
        <Button disabled={scope.busy} loading={picking} onClick={() => void browse()}><Codicon name="folder-opened" />{t('Choose folder')}</Button>
      </div>
    </FormField>
    {project && <code className="checkpoint-full-path selectable-text">{project.paths.join('\n')}</code>}
    {pickerError && <ErrorNotice>{t(pickerError)}</ErrorNotice>}
    {repositories?.id === projectId && repositories?.error && <ErrorNotice onRetry={() => { setRepositories(undefined); setRepositoryRetry(value => value + 1); }}>{t(repositories.error)}</ErrorNotice>}
  </>;
  return <CheckpointPanel project={project} projectRepositories={projectRepositories} projectSelection={projectSelection} projectLoading={projectLoading} projectTasks={preparedProject?.tasks} onCreatingChange={value => {
    setCreationActive(value);
    if (value) { setRepositories(undefined); setRepositoryRetry(value => value + 1); setPickerError(undefined); }
    else { pickerTicket.current += 1; pickerController.current?.abort(); setPicking(false); }
  }} navigation={navigation} onTaskCreated={() => { setRetry(value => value + 1); if (projectId) setExpanded(previous => ({ ...previous, [projectId]: true })); }} onClose={closeCheckpointCenter} />;
}
