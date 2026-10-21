use super::*;
use std::path::Path;

#[tokio::test]
#[ignore = "Manual multi-repository checkpoint capture benchmark"]
async fn benchmark_checkpoint_capture_multi_repository_crlf() {
    let mut f = Fixture::new(4).await;
    for repo in &f.repos {
        let root = Path::new(&repo.root_path);
        git(root, &["config", "core.autocrlf", "true"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
        for index in 0..256 {
            fs::write(
                root.join(format!("中文 file {index}.txt")),
                format!(
                    "repository {} file {index}\r\n{}\r\n",
                    repo.id,
                    "content".repeat(100)
                ),
            )
            .unwrap();
        }
        git(root, &["add", "."], None, &f.token).await.unwrap();
        git(root, &["commit", "-m", "many text files"], None, &f.token)
            .await
            .unwrap();
        git(
            root,
            &["checkout-index", "--all", "--force"],
            None,
            &f.token,
        )
        .await
        .unwrap();
        assert!(fs::read(root.join("中文 file 0.txt"))
            .unwrap()
            .contains(&b'\r'));
        assert!(git(root, &["status", "--porcelain"], None, &f.token)
            .await
            .unwrap()
            .is_empty());
    }
    let start = std::time::Instant::now();
    let task = f.task(TaskIsolation::Original).await;
    let cold = start.elapsed();
    let start = std::time::Instant::now();
    let snapshot = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    eprintln!(
        "CHECKPOINT_BENCH repos=4 files={} create_ms={} repeat_ms={}",
        snapshot
            .repositories
            .iter()
            .map(|repo| repo.working.len())
            .sum::<usize>(),
        cold.as_millis(),
        start.elapsed().as_millis()
    );
}

#[tokio::test]
async fn checkpoint_capture_preserves_crlf_index_and_large_binary_objects() {
    let mut f = Fixture::new(1).await;
    let root = Path::new(&f.repos[0].root_path);
    fs::write(root.join(".gitattributes"), "*.txt text eol=crlf\n").unwrap();
    for index in 0..48 {
        fs::write(
            root.join(format!("中文 file {index}.txt")),
            format!("before {index}\r\n"),
        )
        .unwrap();
    }
    // Bigger than cli::MAX_OUTPUT_BYTES: batch object reads must not truncate
    // binary data or treat its embedded newlines/NULs as framing.
    let mut binary = vec![0x5a; crate::cli::MAX_OUTPUT_BYTES + 1024];
    binary[0..4].copy_from_slice(b"\0\n\r\n");
    fs::write(root.join("large.bin"), &binary).unwrap();
    git(root, &["add", "."], None, &f.token).await.unwrap();
    // Preserve an index version different from the working version.
    fs::write(root.join("large.bin"), b"later working bytes\0").unwrap();
    fs::write(root.join("中文 file 1.txt"), b"later working text\r\n").unwrap();
    let task = f.task(TaskIsolation::Original).await;
    let seed = f.store.snapshot(&task.seed).unwrap();
    let repo = &seed.repositories[0];
    assert_eq!(
        f.store.get(&repo.working["中文 file 0.txt"].hash).unwrap(),
        b"before 0\r\n"
    );
    assert_eq!(
        f.store.get(&repo.index["中文 file 0.txt"].hash).unwrap(),
        b"before 0\n"
    );
    assert_eq!(
        f.store.get(&repo.working["中文 file 1.txt"].hash).unwrap(),
        b"later working text\r\n"
    );
    assert_eq!(
        f.store.get(&repo.index["中文 file 1.txt"].hash).unwrap(),
        b"before 1\n"
    );
    assert_eq!(f.store.get(&repo.index["large.bin"].hash).unwrap(), binary);
    assert_eq!(
        f.store.get(&repo.working["large.bin"].hash).unwrap(),
        b"later working bytes\0"
    );
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        seed
    );
}

#[tokio::test]
async fn checkpoint_capture_rejects_changes_during_capture_and_never_caches_by_mtime() {
    let f = Fixture::new(1).await;
    let root = Path::new(&f.repos[0].root_path);
    for index in 0..8 {
        fs::write(
            root.join(format!("file-{index}")),
            format!("original {index}"),
        )
        .unwrap();
    }
    let first_object = f.store.root.join("objects").join(digest(b"ignored.txt\n"));
    let capture_paths = [f.repos[0].root_path.clone()];
    let (captured, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(capture(&f.store, &capture_paths, &f.token), async {
            while !first_object.exists() {
                tokio::task::yield_now().await;
            }
            fs::write(root.join(".gitignore"), b"changed.txt\n").unwrap();
        },)
    })
    .await
    .unwrap();
    assert!(captured
        .unwrap_err()
        .message
        .contains("Files or index changed"));
    let before = capture(&f.store, &[f.repos[0].root_path.clone()], &f.token)
        .await
        .unwrap();
    let path = root.join(".gitignore");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, b"another.txt\n").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let after = capture(&f.store, &[f.repos[0].root_path.clone()], &f.token)
        .await
        .unwrap();
    assert_ne!(
        before, after,
        "same-size content with the same mtime must be reread"
    );
}

#[tokio::test]
async fn cancelled_checkpoint_creation_joins_object_writers_without_publishing_a_task() {
    let mut f = Fixture::new(1).await;
    let root = Path::new(&f.repos[0].root_path);
    for index in 0..32 {
        fs::write(
            root.join(format!("file-{index}")),
            format!("original {index}"),
        )
        .unwrap();
    }
    let first_object = f.store.root.join("objects").join(digest(b"ignored.txt\n"));
    let repo_ids = f
        .repos
        .iter()
        .map(|repo| repo.id.clone())
        .collect::<Vec<_>>();
    let (created, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(
            create(
                &f.store,
                &mut f.db,
                &f.workspace,
                &f.repos,
                &repo_ids,
                "cancelled",
                RecordingMode::Manual,
                TaskIsolation::Original,
                &[],
                &f.token
            ),
            async {
                while !first_object.exists() {
                    tokio::task::yield_now().await;
                }
                f.token.cancel();
            },
        )
    })
    .await
    .unwrap();
    assert_eq!(created.unwrap_err().code, "REQUEST_CANCELLED");
    assert!(f.db.tasks.is_empty());
    assert!(!f.store.root.join("state.json").exists());
    for object in fs::read_dir(f.store.root.join("objects")).unwrap() {
        let name = object.unwrap().file_name().to_string_lossy().into_owned();
        assert_eq!(name.len(), 64, "all temporary writers were joined");
        f.store.get(&name).unwrap();
    }
}

#[tokio::test]
async fn checkpoint_creation_does_not_wait_for_an_unselected_repository() {
    let f = Fixture::new(2).await;
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let _other_writer = state.write_lock(&f.repos[1].id).await.lock_owned().await;
    let created = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::Create {
                name: "selected only".into(),
                repo_ids: vec![f.repos[0].id.clone()],
                mode: RecordingMode::Manual,
                isolation: TaskIsolation::Original,
                include_ignored: vec![],
            },
            &f.token,
        ),
    )
    .await
    .expect("unselected repository must not block capture")
    .unwrap();
    let task: TaskWorkspace = serde_json::from_value(created).unwrap();
    assert_eq!(task.repositories.len(), 1);
    assert_eq!(task.repositories[0].source_id, f.repos[0].id);
}

#[tokio::test]
async fn capture_verifies_existing_objects_but_duplicate_creation_skips_capture() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let seed = f.store.snapshot(&task.seed).unwrap();
    let hash = &seed.repositories[0].working["file.txt"].hash;
    fs::write(f.store.root.join("objects").join(hash), "damaged").unwrap();
    let error = capture(&f.store, &paths(&task), &f.token)
        .await
        .unwrap_err();
    assert!(error.message.contains("damaged"));
    let error = create(
        &f.store,
        &mut f.db,
        &f.workspace,
        &f.repos,
        &[f.repos[0].id.clone()],
        "duplicate",
        RecordingMode::Manual,
        TaskIsolation::Original,
        &[],
        &f.token,
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("already protects"),
        "duplicates must be rejected before disk capture"
    );
}

#[tokio::test]
async fn batch_capture_supports_sha256_git_indexes() {
    let f = Fixture::new(0).await;
    let root = f.root.join("sha256 repo");
    fs::create_dir(&root).unwrap();
    git(
        &root,
        &["init", "--object-format=sha256", "-b", "main"],
        None,
        &f.token,
    )
    .await
    .unwrap();
    git(&root, &["config", "user.name", "Test"], None, &f.token)
        .await
        .unwrap();
    git(
        &root,
        &["config", "user.email", "test@example.invalid"],
        None,
        &f.token,
    )
    .await
    .unwrap();
    fs::write(root.join("file"), b"staged bytes").unwrap();
    git(&root, &["add", "."], None, &f.token).await.unwrap();
    git(&root, &["commit", "-m", "initial"], None, &f.token)
        .await
        .unwrap();
    fs::write(root.join("file"), b"working bytes").unwrap();
    let snapshot = capture(&f.store, &[root.to_string_lossy().into_owned()], &f.token)
        .await
        .unwrap();
    let repo = &snapshot.repositories[0];
    assert_eq!(
        f.store.get(&repo.index["file"].hash).unwrap(),
        b"staged bytes"
    );
    assert_eq!(
        f.store.get(&repo.working["file"].hash).unwrap(),
        b"working bytes"
    );
}

#[tokio::test]
async fn prepares_an_unopened_project_for_creation_without_switching_or_modifying_sources() {
    let mut first = Fixture::new(1).await;
    first.task(TaskIsolation::Original).await;
    let other = Fixture::new(2).await;
    let state = AppState::load(first.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(first.workspace.clone());
    let app_before = serde_json::to_vec(&*state.app.read().await).unwrap();
    let source_before = capture(
        &other.store,
        &other
            .repos
            .iter()
            .map(|repo| repo.root_path.clone())
            .collect::<Vec<_>>(),
        &first.token,
    )
    .await
    .unwrap();
    let source_before = serde_json::to_vec(&source_before).unwrap();
    let selected: CheckpointProject = serde_json::from_value(
        prepare_project(&state, None, other.workspace.paths.clone(), &first.token)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(selected.workspace.id, other.workspace.id);
    assert_eq!(selected.repositories.len(), 2);
    assert!(selected.tasks.is_empty());
    assert_eq!(
        serde_json::to_vec(&*state.app.read().await).unwrap(),
        app_before
    );
    let catalog_before: CheckpointCatalog =
        serde_json::from_value(catalog(&state, &first.token).await.unwrap()).unwrap();
    assert_eq!(
        catalog_before.projects.len(),
        1,
        "selecting a folder must not create a task or empty sidebar group"
    );
    let task: TaskWorkspace = serde_json::from_value(
        handle(
            &state,
            &selected.workspace.id,
            CheckpointAction::Create {
                name: "Unopened project task".into(),
                repo_ids: selected
                    .repositories
                    .iter()
                    .map(|repo| repo.id.clone())
                    .collect(),
                mode: RecordingMode::Manual,
                isolation: TaskIsolation::Original,
                include_ignored: vec![],
            },
            &first.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(task.workspace_id, other.workspace.id);
    let selected_again: CheckpointProject = serde_json::from_value(
        prepare_project(&state, Some(&selected.workspace.id), vec![], &first.token)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(selected_again.tasks[0].id, task.id);
    let output: CheckpointCatalog =
        serde_json::from_value(catalog(&state, &first.token).await.unwrap()).unwrap();
    assert_eq!(output.projects.len(), 2);
    let source_after = capture(
        &other.store,
        &other
            .repos
            .iter()
            .map(|repo| repo.root_path.clone())
            .collect::<Vec<_>>(),
        &first.token,
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_vec(&source_after).unwrap(), source_before);
    assert_eq!(
        serde_json::to_vec(&*state.app.read().await).unwrap(),
        app_before
    );
    let before = fs::read(first.store.root.join("state.json")).unwrap();
    assert!(prepare_project(&state, None, vec![], &first.token)
        .await
        .is_err());
    assert!(prepare_project(
        &state,
        Some(&selected.workspace.id),
        selected.workspace.paths,
        &first.token
    )
    .await
    .is_err());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        prepare_project(&state, Some(&selected.workspace.id), vec![], &cancelled)
            .await
            .is_err()
    );
    assert_eq!(
        fs::read(first.store.root.join("state.json")).unwrap(),
        before
    );
}

#[tokio::test]
async fn global_catalog_preserves_owners_and_can_manage_a_project_removed_from_recents() {
    let mut first = Fixture::new(1).await;
    let first_task = first.task(TaskIsolation::Original).await;
    let second = Fixture::new(1).await;
    let second_task = create(
        &first.store,
        &mut first.db,
        &second.workspace,
        &second.repos,
        &second
            .repos
            .iter()
            .map(|repo| repo.id.clone())
            .collect::<Vec<_>>(),
        "Second task",
        RecordingMode::Manual,
        TaskIsolation::Original,
        &[],
        &first.token,
    )
    .await
    .unwrap();
    let state = AppState::load(first.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(first.workspace.clone());
    let output: CheckpointCatalog =
        serde_json::from_value(catalog(&state, &first.token).await.unwrap()).unwrap();
    assert_eq!(output.projects.len(), 2);
    assert_eq!(output.tasks.len(), 2);
    assert!(output.projects.iter().any(
        |project| project.id == second.workspace.id && project.paths == second.workspace.paths
    ));
    let wrong = handle(
        &state,
        &first.workspace.id,
        CheckpointAction::Begin {
            task_id: second_task.id.clone(),
            name: "wrong owner".into(),
        },
        &first.token,
    )
    .await
    .unwrap_err();
    assert!(wrong.message.contains("does not belong"));
    handle(
        &state,
        &second.workspace.id,
        CheckpointAction::Begin {
            task_id: second_task.id.clone(),
            name: "second project".into(),
        },
        &first.token,
    )
    .await
    .unwrap();
    let db = first.store.read().unwrap();
    assert!(db
        .tasks
        .iter()
        .find(|task| task.id == first_task.id)
        .unwrap()
        .checkpoints
        .is_empty());
    assert_eq!(
        db.tasks
            .iter()
            .find(|task| task.id == second_task.id)
            .unwrap()
            .checkpoints[0]
            .status,
        "recording"
    );
    assert_eq!(
        state.app.read().await.recent_workspaces.len(),
        1,
        "global management must not reopen the project"
    );
    handle(
        &state,
        &second.workspace.id,
        CheckpointAction::Finish {
            task_id: second_task.id.clone(),
        },
        &first.token,
    )
    .await
    .unwrap();
    // Old databases have no saved project descriptor. Keep their tasks discoverable.
    let mut db = first.store.read().unwrap();
    db.projects.clear();
    first.store.save(&db).unwrap();
    let output: CheckpointCatalog =
        serde_json::from_value(catalog(&state, &first.token).await.unwrap()).unwrap();
    assert_eq!(output.projects.len(), 2);
    let bytes = fs::read(first.store.root.join("state.json")).unwrap();
    handle(
        &state,
        &second.workspace.id,
        CheckpointAction::Overview,
        &first.token,
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(first.store.root.join("state.json")).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn message_envelopes_repair_legacy_titles_without_touching_restore_identity() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let raw = "# Files mentioned by the user:\n\n## 截图.png: /tmp/中文 路径/截图.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n统一优化\n\n---\n这是正文里的分隔符";
    begin(
        &f.store,
        &mut f.db,
        &task.id,
        "",
        Some(("chat", "1")),
        Some(raw),
        &f.token,
    )
    .await
    .unwrap();
    assert_eq!(f.db.tasks[0].checkpoints[0].name, "统一优化");
    let path = Path::new(&task.repositories[0].task_path).join("envelope.txt");
    fs::write(&path, "changes").unwrap();
    f.end(&task).await;
    // Simulate an old automatically generated title; no durable migration is needed.
    f.db.tasks[0].checkpoints[0].name = "# Files mentioned by the user:".into();
    let point = f.db.tasks[0].checkpoints[0].clone();
    let extra = "# Response annotations:\nEach item contains text selected from an earlier Codex response.\n<response-annotations>\n[{\"text\":\"引用\",\"annotation\":\"还有这种，都优化下\"}]\n</response-annotations>\n\n## My request:\n";
    f.db.additional_messages.insert(
        point.id.clone(),
        vec![f.store.put(extra.as_bytes()).unwrap()],
    );
    f.store.save(&f.db).unwrap();
    let durable = fs::read(f.store.root.join("state.json")).unwrap();
    let preview = f.preview(&task, None, false).await;
    let messages = prompt::messages(&f.store, &f.db, &task.id, &point.id).unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].body, "统一优化\n\n---\n这是正文里的分隔符");
    assert_eq!(messages[0].raw.as_deref(), Some(raw));
    assert_eq!(messages[1].annotations[0].comment, "还有这种，都优化下");
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let response: Vec<CheckpointMessage> = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::Messages {
                task_id: task.id.clone(),
                checkpoint_id: point.id.clone(),
            },
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response.len(), 2);
    let activity: CheckpointActivity = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::Activity,
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(activity.tasks[0].checkpoints[0].name, "统一优化");
    assert_eq!(
        history::overview(&f.store, &f.db, &f.workspace)
            .unwrap()
            .tasks[0]
            .checkpoints[0]
            .name,
        "统一优化"
    );
    assert_eq!(
        history::page(&f.store, &f.db, &task.id, "优化下", None, false, 0, None)
            .unwrap()
            .matching,
        1
    );
    assert_eq!(
        history::page(
            &f.store,
            &f.db,
            &task.id,
            "Distinguish instructions",
            None,
            false,
            0,
            None
        )
        .unwrap()
        .matching,
        0
    );
    assert_eq!(
        f.store.get(point.prompt_hash.as_ref().unwrap()).unwrap(),
        raw.as_bytes()
    );
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), durable);
    assert_eq!(
        f.execute(preview).await.status,
        "succeeded",
        "display repair must not invalidate preflight"
    );
    assert!(!path.exists());
    rename(&f.store, &mut f.db, &task.id, &point.id, "自定义名称").unwrap();
    let page = history::page(&f.store, &f.db, &task.id, "", None, false, 0, None).unwrap();
    assert_eq!(page.points[0].name, "自定义名称");
    rename(
        &f.store,
        &mut f.db,
        &task.id,
        &point.id,
        "# Files mentioned by the user:",
    )
    .unwrap();
    let db = f.store.read().unwrap();
    let page = history::page(&f.store, &db, &task.id, "", None, false, 0, None).unwrap();
    assert_eq!(
        page.points[0].name, "# Files mentioned by the user:",
        "an explicit custom title wins over the legacy heuristic"
    );
}

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    store: Storage,
    db: Database,
    workspace: WorkspaceDescriptor,
    repos: Vec<RepositoryMeta>,
    token: CancellationToken,
}
impl Fixture {
    async fn new(count: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("中文 project");
        fs::create_dir_all(&root).unwrap();
        let token = CancellationToken::new();
        for i in 0..count {
            let path = root.join(format!("repo-{i}"));
            fs::create_dir(&path).unwrap();
            for args in [
                vec!["init", "-b", "main"],
                vec!["config", "user.name", "Checkpoint Test"],
                vec!["config", "user.email", "test@example.invalid"],
                vec!["config", "core.autocrlf", "false"],
            ] {
                git(&path, &args, None, &token).await.unwrap();
            }
            fs::write(
                path.join("file.txt"),
                b"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
            )
            .unwrap();
            fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();
            git(&path, &["add", "."], None, &token).await.unwrap();
            git(&path, &["commit", "-m", "initial"], None, &token)
                .await
                .unwrap();
        }
        let workspace =
            crate::workspace::descriptor(vec![root.to_string_lossy().into_owned()]).unwrap();
        let repos =
            crate::workspace::scan(&workspace, &crate::models::DesktopSettings::default()).unwrap();
        let store = Storage::new(&directory.path().join("config")).unwrap();
        Self {
            _directory: directory,
            root,
            store,
            db: Database::default(),
            workspace,
            repos,
            token,
        }
    }
    async fn task(&mut self, isolation: TaskIsolation) -> TaskWorkspace {
        create(
            &self.store,
            &mut self.db,
            &self.workspace,
            &self.repos,
            &self.repos.iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
            "test task",
            RecordingMode::Manual,
            isolation,
            &[],
            &self.token,
        )
        .await
        .unwrap()
    }
    async fn automatic_task(&mut self) -> TaskWorkspace {
        let mut task = self.task(TaskIsolation::Original).await;
        task.mode = RecordingMode::Automatic;
        self.db.tasks[0] = task.clone();
        self.store.save(&self.db).unwrap();
        task
    }
    async fn send_hook(
        &self,
        task: &TaskWorkspace,
        event: &str,
        session: &str,
        turn: &str,
    ) -> Result<(), DesktopError> {
        hook(
            self.store.root.parent().unwrap(),
            HookInput {
                cwd: task.path.clone(),
                session_id: session.into(),
                turn_id: Some(turn.into()),
                hook_event_name: event.into(),
                prompt: None,
            },
            &self.token,
        )
        .await
    }
    async fn start(&mut self, task: &TaskWorkspace) {
        begin(
            &self.store,
            &mut self.db,
            &task.id,
            "test turn",
            None,
            None,
            &self.token,
        )
        .await
        .unwrap();
    }
    async fn end(&mut self, task: &TaskWorkspace) {
        finish(&self.store, &mut self.db, &task.id, &self.token)
            .await
            .unwrap();
    }
    async fn preview(
        &mut self,
        task: &TaskWorkspace,
        selected: Option<&str>,
        bring_back: bool,
    ) -> Prepared {
        prepare(
            &self.store,
            self.db.tasks.iter().find(|t| t.id == task.id).unwrap(),
            selected,
            bring_back,
            &self.token,
        )
        .await
        .unwrap()
    }
    async fn execute(&mut self, prepared: Prepared) -> RestoreReport {
        assert!(
            prepared.preview.conflicts.is_empty(),
            "{:?}",
            prepared.preview.conflicts
        );
        self.db.transactions.push(Transaction {
            report: RestoreReport {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: prepared.preview.task_id.clone(),
                status: "pending".into(),
                completed: 0,
                total: prepared.preview.files.len() as u32,
                error: None,
            },
            prepared,
            recovery_before: None,
            recovery_expected: None,
        });
        let index = self.db.transactions.len() - 1;
        apply(&self.store, &mut self.db, index, false, &self.token)
            .await
            .unwrap()
    }
}
#[tokio::test]
async fn original_three_repositories_undo_untracked_without_new_directories() {
    let mut f = Fixture::new(3).await;
    let task = f.task(TaskIsolation::Original).await;
    assert_eq!(Path::new(&task.path), dunce::canonicalize(&f.root).unwrap());
    assert!(task
        .repositories
        .iter()
        .all(|r| r.source_path == r.task_path));
    f.start(&task).await;
    for repo in &task.repositories {
        fs::write(Path::new(&repo.task_path).join("new.py"), "print('test')\n").unwrap();
    }
    f.end(&task).await;
    let preview = f.preview(&task, None, false).await;
    assert_eq!(preview.preview.files.len(), 3);
    assert_eq!(f.execute(preview).await.status, "succeeded");
    for repo in &task.repositories {
        assert!(!Path::new(&repo.task_path).join("new.py").exists());
    }
}
#[tokio::test]
async fn isolated_task_copies_dirty_index_and_working_without_touching_source() {
    let mut f = Fixture::new(1).await;
    let source = Path::new(&f.repos[0].root_path);
    fs::write(source.join("file.txt"), "staged\n").unwrap();
    git(source, &["add", "file.txt"], None, &f.token)
        .await
        .unwrap();
    fs::write(source.join("file.txt"), "working\n").unwrap();
    fs::write(source.join("untracked"), "existing\n").unwrap();
    fs::write(source.join("ignored.txt"), "secret\n").unwrap();
    let before = capture(&f.store, &[source.to_string_lossy().into_owned()], &f.token)
        .await
        .unwrap();
    let task = f.task(TaskIsolation::Worktree).await;
    let after = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    assert_eq!(
        after.repositories[0].working,
        before.repositories[0].working
    );
    assert_eq!(after.repositories[0].index, before.repositories[0].index);
    assert_eq!(
        capture(
            &f.store,
            &[task.repositories[0].source_path.clone()],
            &f.token
        )
        .await
        .unwrap(),
        before
    );
    assert!(!Path::new(&task.repositories[0].task_path)
        .join("ignored.txt")
        .exists());
}
#[tokio::test]
async fn parallel_isolated_tasks_undo_independently() {
    let mut f = Fixture::new(2).await;
    let a = f.task(TaskIsolation::Worktree).await;
    let b = f.task(TaskIsolation::Worktree).await;
    f.start(&a).await;
    f.start(&b).await;
    for task in [&a, &b] {
        for repo in &task.repositories {
            fs::write(Path::new(&repo.task_path).join("new"), &task.id).unwrap();
        }
    }
    f.end(&a).await;
    f.end(&b).await;
    let preview = f.preview(&a, None, false).await;
    f.execute(preview).await;
    assert!(b
        .repositories
        .iter()
        .all(|r| Path::new(&r.task_path).join("new").exists()));
    assert!(a
        .repositories
        .iter()
        .all(|r| !Path::new(&r.task_path).join("new").exists()));
}
#[tokio::test]
async fn reverse_three_way_merge_keeps_later_nonoverlapping_changes() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let path = Path::new(&task.repositories[0].task_path).join("file.txt");
    let original = fs::read_to_string(&path).unwrap();
    f.start(&task).await;
    fs::write(&path, original.replace("one", "ONE")).unwrap();
    f.end(&task).await;
    fs::write(&path, original.replace("one", "ONE").replace("ten", "TEN")).unwrap();
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        original.replace("ten", "TEN")
    );
}
#[tokio::test]
async fn overlapping_change_prevents_whole_batch() {
    let mut f = Fixture::new(2).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for repo in &task.repositories {
        fs::write(Path::new(&repo.task_path).join("file.txt"), "turn\n").unwrap();
    }
    f.end(&task).await;
    fs::write(
        Path::new(&task.repositories[1].task_path).join("file.txt"),
        "later\n",
    )
    .unwrap();
    let preview = f.preview(&task, None, false).await;
    assert!(!preview.preview.conflicts.is_empty());
    assert_eq!(
        fs::read_to_string(Path::new(&task.repositories[0].task_path).join("file.txt")).unwrap(),
        "turn\n"
    );
}
#[tokio::test]
async fn restore_keeps_staged_and_unstaged_layers_separate() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.path).join("repo-0");
    fs::write(root.join("file.txt"), "before staged\n").unwrap();
    git(&root, &["add", "file.txt"], None, &f.token)
        .await
        .unwrap();
    fs::write(root.join("file.txt"), "before working\n").unwrap();
    let initial = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    f.start(&task).await;
    fs::write(root.join("file.txt"), "after staged\n").unwrap();
    git(&root, &["add", "file.txt"], None, &f.token)
        .await
        .unwrap();
    fs::write(root.join("file.txt"), "after working\n").unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        initial
    );
}
#[tokio::test]
async fn rollback_earlier_turn_also_rolls_back_following_turns() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    f.start(&task).await;
    fs::write(root.join("a"), "a").unwrap();
    f.end(&task).await;
    let first = f.db.tasks[0].checkpoints[0].id.clone();
    f.start(&task).await;
    fs::write(root.join("b"), "b").unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, Some(&first), false).await;
    assert_eq!(preview.preview.checkpoint_count, 2);
    f.execute(preview).await;
    assert!(!root.join("a").exists());
    assert!(!root.join("b").exists());
    assert!(f.db.tasks[0]
        .checkpoints
        .iter()
        .all(|p| p.status == "undone"));
}
#[tokio::test]
async fn bring_back_preserves_source_index_and_can_be_recovered() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Worktree).await;
    let source = Path::new(&task.repositories[0].source_path);
    let root = Path::new(&task.repositories[0].task_path);
    fs::write(source.join("existing"), "staged source").unwrap();
    git(source, &["add", "existing"], None, &f.token)
        .await
        .unwrap();
    fs::write(root.join("result"), "task result").unwrap();
    let before = capture(&f.store, &[source.to_string_lossy().into_owned()], &f.token)
        .await
        .unwrap();
    let preview = f.preview(&task, None, true).await;
    let result = f.execute(preview).await;
    assert_eq!(result.status, "succeeded");
    assert!(source.join("result").exists());
    assert_eq!(
        capture(&f.store, &[source.to_string_lossy().into_owned()], &f.token)
            .await
            .unwrap()
            .repositories[0]
            .index,
        before.repositories[0].index
    );
    let index = f.db.transactions.len() - 1;
    let report = apply(&f.store, &mut f.db, index, true, &f.token)
        .await
        .unwrap();
    assert_eq!(report.status, "recovered");
    assert_eq!(
        capture(&f.store, &[source.to_string_lossy().into_owned()], &f.token)
            .await
            .unwrap(),
        before
    );
}
#[tokio::test]
async fn stale_preview_is_rejected_before_writes() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("new"),
        "new",
    )
    .unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, None, false).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("new"),
        "later",
    )
    .unwrap();
    f.db.transactions.push(Transaction {
        report: RestoreReport {
            id: "tx".into(),
            task_id: task.id.clone(),
            status: "pending".into(),
            completed: 0,
            total: 1,
            error: None,
        },
        prepared: preview,
        recovery_before: None,
        recovery_expected: None,
    });
    assert!(apply(&f.store, &mut f.db, 0, false, &f.token)
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(Path::new(&task.repositories[0].task_path).join("new")).unwrap(),
        "later"
    );
}
#[tokio::test]
async fn binary_crlf_deletion_and_unicode_paths_restore_exact_bytes() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    fs::write(root.join("中文 name.bin"), b"a\0b\r\nc").unwrap();
    let before = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    f.start(&task).await;
    fs::remove_file(root.join("file.txt")).unwrap();
    fs::write(root.join("中文 name.bin"), b"x\0y\r\nz").unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, None, false).await;
    f.execute(preview).await;
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        before
    );
}
#[cfg(unix)]
#[tokio::test]
async fn links_and_executable_bits_restore_without_following_links() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    symlink("/outside/nonexistent", root.join("link")).unwrap();
    fs::set_permissions(root.join("file.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let before = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    f.start(&task).await;
    fs::remove_file(root.join("link")).unwrap();
    symlink("/other", root.join("link")).unwrap();
    fs::set_permissions(root.join("file.txt"), fs::Permissions::from_mode(0o644)).unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, None, false).await;
    f.execute(preview).await;
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        before
    );
}
#[tokio::test]
async fn head_changes_block_undo_and_corrupted_objects_are_detected() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    f.start(&task).await;
    fs::write(root.join("new"), "new").unwrap();
    git(root, &["add", "."], None, &f.token).await.unwrap();
    git(root, &["commit", "-m", "changed history"], None, &f.token)
        .await
        .unwrap();
    f.end(&task).await;
    assert!(prepare(&f.store, &f.db.tasks[0], None, false, &f.token)
        .await
        .is_err());
    let hash = f.store.put(b"valid").unwrap();
    fs::write(f.store.root.join("objects").join(&hash), "damaged").unwrap();
    assert!(f.store.get(&hash).is_err());
}
#[tokio::test]
async fn hook_events_are_idempotent_and_other_sessions_are_blocked() {
    let mut f = Fixture::new(1).await;
    let mut task = f.task(TaskIsolation::Original).await;
    task.mode = RecordingMode::Automatic;
    f.db.tasks[0] = task.clone();
    f.store.save(&f.db).unwrap();
    let config = f.store.root.parent().unwrap().to_path_buf();
    let input = |event: &str, session: &str, turn: &str| HookInput {
        cwd: task.path.clone(),
        session_id: session.into(),
        turn_id: Some(turn.into()),
        hook_event_name: event.into(),
        prompt: None,
    };
    hook(&config, input("UserPromptSubmit", "a", "1"), &f.token)
        .await
        .unwrap();
    hook(&config, input("UserPromptSubmit", "a", "1"), &f.token)
        .await
        .unwrap();
    assert!(hook(&config, input("UserPromptSubmit", "b", "2"), &f.token)
        .await
        .is_err());
    hook(&config, input("Interrupt", "a", "1"), &f.token)
        .await
        .unwrap();
    let db = f.store.read().unwrap();
    assert_eq!(db.tasks[0].checkpoints.len(), 1);
    assert_eq!(db.tasks[0].checkpoints[0].status, "interrupted");
}
#[tokio::test]
async fn unexpected_git_lock_is_preserved() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    f.start(&task).await;
    fs::write(root.join("new"), "new").unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, None, false).await;
    fs::write(root.join(".git/index.lock"), "other process").unwrap();
    f.db.transactions.push(Transaction {
        report: RestoreReport {
            id: "tx".into(),
            task_id: task.id,
            status: "pending".into(),
            completed: 0,
            total: 1,
            error: None,
        },
        prepared: preview,
        recovery_before: None,
        recovery_expected: None,
    });
    assert!(apply(&f.store, &mut f.db, 0, false, &f.token)
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(root.join(".git/index.lock")).unwrap(),
        "other process"
    );
    assert!(root.join("new").exists());
}
#[test]
fn path_escape_and_git_admin_files_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    assert!(location(root.path(), "../outside").is_err());
    assert!(location(root.path(), ".git/config").is_err());
}
#[tokio::test]
async fn partial_cross_repository_failure_is_persisted_and_recoverable() {
    let mut f = Fixture::new(2).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for repo in &task.repositories {
        fs::write(Path::new(&repo.task_path).join("new"), "result").unwrap();
    }
    f.end(&task).await;
    let before = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    let preview = f.preview(&task, None, false).await;
    fs::write(f.store.root.join("test-fail-after-write"), "").unwrap();
    let report = f.execute(preview).await;
    assert_eq!(report.status, "failed");
    assert_eq!(report.completed, 1);
    f.db = f.store.read().unwrap();
    fs::remove_file(f.store.root.join("test-fail-after-write")).unwrap();
    let report = apply(&f.store, &mut f.db, 0, true, &f.token).await.unwrap();
    assert_eq!(report.status, "recovered");
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        before
    );
    assert_eq!(f.db.tasks[0].checkpoints[0].status, "completed");
}
#[tokio::test]
async fn reverting_multiple_turns_preserves_manual_changes_between_turns() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    f.start(&task).await;
    fs::write(root.join("a"), "turn1").unwrap();
    f.end(&task).await;
    let first = f.db.tasks[0].checkpoints[0].id.clone();
    fs::write(root.join("manual"), "between turns").unwrap();
    f.start(&task).await;
    fs::write(root.join("b"), "turn2").unwrap();
    f.end(&task).await;
    let preview = f.preview(&task, Some(&first), false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    assert!(root.join("manual").is_file());
    assert!(!root.join("a").exists());
    assert!(!root.join("b").exists());
}
#[tokio::test]
async fn successive_bring_back_applies_only_new_changes() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Worktree).await;
    let root = Path::new(&task.repositories[0].task_path);
    let source = Path::new(&task.repositories[0].source_path);
    fs::write(root.join("result"), "first").unwrap();
    let preview = f.preview(&task, None, true).await;
    f.execute(preview).await;
    fs::write(root.join("result"), "second").unwrap();
    let preview = f.preview(&task, None, true).await;
    assert!(preview.preview.conflicts.is_empty());
    f.execute(preview).await;
    assert_eq!(fs::read_to_string(source.join("result")).unwrap(), "second");
    let index = f.db.transactions.len() - 1;
    apply(&f.store, &mut f.db, index, true, &f.token)
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(source.join("result")).unwrap(), "first");
}
#[tokio::test]
async fn unsupported_initial_and_unmerged_repositories_fail_before_task_creation() {
    let mut f = Fixture::new(1).await;
    let root = Path::new(&f.repos[0].root_path);
    fs::write(root.join(".git/MERGE_HEAD"), "anything").unwrap();
    assert!(capture(&f.store, &[f.repos[0].root_path.clone()], &f.token)
        .await
        .is_err());
    fs::remove_file(root.join(".git/MERGE_HEAD")).unwrap();
    let task = f.task(TaskIsolation::Original).await;
    let err = create(
        &f.store,
        &mut f.db,
        &f.workspace,
        &f.repos,
        &[f.repos[0].id.clone()],
        "duplicate",
        RecordingMode::Manual,
        TaskIsolation::Original,
        &[],
        &f.token,
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("already protects"));
    assert_eq!(f.db.tasks[0].id, task.id);
}
#[tokio::test]
async fn hook_start_stop_work_without_ui_accepts_events_without_prompt() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.db.tasks[0].mode = RecordingMode::Automatic;
    f.store.save(&f.db).unwrap();
    let config = f.store.root.parent().unwrap();
    let event = |name: &str| HookInput {
        cwd: task.path.clone(),
        session_id: "desktop-like-session".into(),
        turn_id: Some("1".into()),
        hook_event_name: name.into(),
        prompt: None,
    };
    hook(config, event("UserPromptSubmit"), &f.token)
        .await
        .unwrap();
    fs::write(
        Path::new(&task.repositories[0].task_path).join("new"),
        "from Codex",
    )
    .unwrap();
    hook(config, event("Stop"), &f.token).await.unwrap();
    hook(config, event("Stop"), &f.token).await.unwrap();
    f.db = f.store.read().unwrap();
    assert_eq!(f.db.tasks[0].checkpoints.len(), 1);
    assert_eq!(f.db.tasks[0].checkpoints[0].status, "completed");
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
}
#[test]
fn installing_hooks_preserves_other_handlers_and_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("hooks.json");
    let existing = serde_json::json!({"description":"keep me", "unknown":{"keep":true}, "hooks":{"Stop":[{"matcher":".*", "hooks":[{"type":"command","command":"echo existing"}]}]}});
    fs::write(&path, serde_json::to_vec(&existing).unwrap()).unwrap();
    install_hooks_at(directory.path(), &path, Path::new("/fake path/versiondock")).unwrap();
    install_hooks_at(directory.path(), &path, Path::new("/fake path/versiondock")).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(data["description"], "keep me");
    assert_eq!(data["unknown"]["keep"], true);
    let stop = data["hooks"]["Stop"].as_array().unwrap();
    assert!(stop
        .iter()
        .any(|group| group["hooks"][0]["command"] == "echo existing"));
    for event in ["UserPromptSubmit", "Stop", "Interrupt"] {
        let handlers = data["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap())
            .filter(|h| {
                h["command"]
                    .as_str()
                    .unwrap()
                    .contains("--versiondock-checkpoint-hook")
            })
            .count();
        assert_eq!(handlers, 1);
    }
    assert_eq!(
        fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|p| p.file_name().to_string_lossy().contains("backup"))
            .count(),
        2
    );
}
#[test]
fn installing_release_and_dev_hooks_keeps_both_targets_and_replaces_moved_executables() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("Codex home").join("hooks.json");
    let release_config = directory.path().join("VersionDock 数据");
    let dev_config = directory.path().join("VersionDock 数据.dev");
    let release_exe = directory.path().join("Release app");
    let dev_exe = directory.path().join("Dev app");
    let moved_exe = directory.path().join("Moved dev app");
    for exe in [&release_exe, &dev_exe, &moved_exe] {
        fs::write(exe, "test executable").unwrap();
    }
    install_hooks_at(&release_config, &target, &release_exe).unwrap();
    assert!(!has_hooks_for_config(&target, &dev_config).unwrap());
    assert!(!hooks_installed_at(&target, &dev_config, &dev_exe).unwrap());
    install_hooks_at(&dev_config, &target, &dev_exe).unwrap();
    // Reinstall either app without displacing its peer or creating duplicates.
    install_hooks_at(&release_config, &target, &release_exe).unwrap();
    install_hooks_at(&dev_config, &target, &dev_exe).unwrap();
    install_hooks_at(&dev_config, &target, &moved_exe).unwrap();
    assert!(hooks_installed_at(&target, &release_config, &release_exe).unwrap());
    assert!(hooks_installed_at(&target, &dev_config, &moved_exe).unwrap());
    assert!(!hooks_installed_at(&target, &dev_config, &dev_exe).unwrap());
    assert!(has_hooks_for_config(&target, &release_config).unwrap());
    assert!(has_hooks_for_config(&target, &dev_config).unwrap());
    let data: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    for event in ["UserPromptSubmit", "Stop", "Interrupt"] {
        let commands: Vec<_> = data["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| group["hooks"].as_array().unwrap())
            .map(|handler| handler["command"].as_str().unwrap())
            .collect();
        assert_eq!(commands.len(), 2);
        assert!(commands.contains(
            &hook_command(&release_config, &release_exe)
                .unwrap()
                .as_str()
        ));
        assert!(commands.contains(&hook_command(&dev_config, &moved_exe).unwrap().as_str()));
    }
}

#[tokio::test]
async fn release_and_dev_hooks_record_independently_when_both_receive_the_same_events() {
    for shared_project in [false, true] {
        let mut release = Fixture::new(1).await;
        let mut dev = Fixture::new(1).await;
        if shared_project {
            dev.root = release.root.clone();
            dev.workspace = release.workspace.clone();
            dev.repos = release.repos.clone();
        }
        let release_task = release.automatic_task().await;
        let dev_task = dev.automatic_task().await;
        let targets = if shared_project {
            vec![&release_task]
        } else {
            vec![&release_task, &dev_task]
        };
        for (index, task) in targets.into_iter().enumerate() {
            let turn = index.to_string();
            let (left, right) = tokio::join!(
                release.send_hook(task, "UserPromptSubmit", "shared-codex-session", &turn),
                dev.send_hook(task, "UserPromptSubmit", "shared-codex-session", &turn),
            );
            left.unwrap();
            right.unwrap();
            fs::write(
                Path::new(&task.repositories[0].task_path).join("from-codex"),
                "shared event output",
            )
            .unwrap();
            let (left, right) = tokio::join!(
                release.send_hook(task, "Stop", "shared-codex-session", &turn),
                dev.send_hook(task, "Stop", "shared-codex-session", &turn),
            );
            left.unwrap();
            right.unwrap();
        }
        let release_db = release.store.read().unwrap();
        let dev_db = dev.store.read().unwrap();
        for (db, task, config) in [
            (
                &release_db,
                &release_task,
                release.store.root.parent().unwrap(),
            ),
            (&dev_db, &dev_task, dev.store.root.parent().unwrap()),
        ] {
            assert_eq!(db.tasks.len(), 1);
            assert_eq!(db.tasks[0].id, task.id);
            assert_eq!(db.tasks[0].checkpoints.len(), 1);
            assert_eq!(db.tasks[0].checkpoints[0].status, "completed");
            assert_eq!(
                db.verified_hooks[&task.id].command_fingerprint,
                digest(
                    hook_command(config, &std::env::current_exe().unwrap())
                        .unwrap()
                        .as_bytes()
                )
            );
        }
        assert_ne!(
            release_db.verified_hooks[&release_task.id].command_fingerprint,
            dev_db.verified_hooks[&dev_task.id].command_fingerprint
        );
    }
}

#[test]
fn installing_hooks_preserves_foreign_handlers_in_shared_matcher_groups() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("hooks.json");
    let config = directory.path().join("app");
    let foreign_config = directory.path().join("app.dev");
    let foreign = serde_json::json!({"type":"command", "command":hook_command(&foreign_config, Path::new("/other executable")).unwrap(), "timeout":127, "custom":"retained"});
    let unrelated = serde_json::json!({"type":"command", "command":"echo --versiondock-checkpoint-hook documentation", "timeout":42});
    let old = serde_json::json!({"type":"command", "command":hook_command(&config, Path::new("/old executable")).unwrap()});
    let existing = serde_json::json!({"hooks":{"Stop":[{"matcher":".*", "custom":"group", "hooks":[foreign.clone(), unrelated.clone(), old]}]}});
    fs::write(&target, serde_json::to_vec(&existing).unwrap()).unwrap();
    install_hooks_at(&config, &target, Path::new("/new executable")).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    assert_eq!(
        data["hooks"]["Stop"][0],
        serde_json::json!({"matcher":".*", "custom":"group", "hooks":[foreign,unrelated]})
    );
}

#[test]
fn simultaneous_hook_installations_preserve_both_apps() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("hooks.json");
    let configs = [
        directory.path().join("release"),
        directory.path().join("dev"),
    ];
    let exes = [
        directory.path().join("release executable"),
        directory.path().join("dev executable"),
    ];
    for exe in &exes {
        fs::write(exe, "test executable").unwrap();
    }
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        for (config, exe) in configs.iter().zip(&exes) {
            let barrier = &barrier;
            let target = &target;
            scope.spawn(move || {
                barrier.wait();
                install_hooks_at(config, target, exe).unwrap();
            });
        }
    });
    for (config, exe) in configs.iter().zip(&exes) {
        assert!(hooks_installed_at(&target, config, exe).unwrap());
    }
}

#[test]
fn hook_installation_identity_matches_the_complete_quoted_data_directory() {
    let config = Path::new("/data/VersionDock 中文");
    let command = hook_command(config, Path::new("/applications/VersionDock app")).unwrap();
    let quoted = quote_command(&config.to_string_lossy()).unwrap();
    assert!(hook_targets_config(&command, &quoted));
    for foreign in [
        "/data/VersionDock 中文.dev",
        "/data/VersionDock",
        "/other/VersionDock 中文",
    ] {
        assert!(!hook_targets_config(
            &command,
            &quote_command(foreign).unwrap()
        ));
    }
    assert!(!hook_targets_config(&format!("{command} extra"), &quoted));
    assert!(!hook_targets_config(
        "echo --versiondock-checkpoint-hook",
        &quoted
    ));
    #[cfg(not(windows))]
    {
        let escaped = Path::new("/data/user's --versiondock-checkpoint-hook config");
        let command = hook_command(escaped, Path::new("/app/VersionDock")).unwrap();
        assert!(hook_targets_config(
            &command,
            &quote_command(&escaped.to_string_lossy()).unwrap()
        ));
    }
}

#[tokio::test]
async fn two_linked_source_worktrees_can_create_distinct_task_branches() {
    let mut f = Fixture::new(1).await;
    let sibling = f.root.join("linked");
    git(
        Path::new(&f.repos[0].root_path),
        &[
            "worktree",
            "add",
            "-b",
            "source-linked",
            sibling.to_str().unwrap(),
        ],
        None,
        &f.token,
    )
    .await
    .unwrap();
    f.repos =
        crate::workspace::scan(&f.workspace, &crate::models::DesktopSettings::default()).unwrap();
    let task = f.task(TaskIsolation::Worktree).await;
    assert_eq!(task.repositories.len(), 2);
    assert_ne!(task.repositories[0].branch, task.repositories[1].branch);
}
#[tokio::test]
async fn a_replaced_lock_is_not_removed_by_the_checkpoint_guard() {
    let f = Fixture::new(1).await;
    let root = Path::new(&f.repos[0].root_path);
    let guard = index_lock(root, &f.token).await.unwrap();
    let path = guard.lock.clone();
    fs::remove_file(&path).unwrap();
    fs::write(&path, "replacement from another process").unwrap();
    drop(guard);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "replacement from another process"
    );
}

#[tokio::test]
async fn snapshot_diffs_keep_repository_layer_and_preview_direction() {
    let mut f = Fixture::new(2).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for (index, repo) in task.repositories.iter().enumerate() {
        let root = Path::new(&repo.task_path);
        fs::write(root.join("same 文件.ts"), format!("staged-{index}\n")).unwrap();
        git(root, &["add", "same 文件.ts"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join("same 文件.ts"), format!("working-{index}\n")).unwrap();
    }
    f.end(&task).await;
    let point = f.db.tasks[0].checkpoints.last().unwrap();
    let source = CheckpointDiffSource::Checkpoint {
        task_id: task.id.clone(),
        checkpoint_id: point.id.clone(),
    };
    // Later external edits must never appear in a historical checkpoint diff.
    fs::write(
        Path::new(&task.repositories[0].task_path).join("same 文件.ts"),
        "later\n",
    )
    .unwrap();
    for (index, repo) in task.repositories.iter().enumerate() {
        for layer in ["working", "index"] {
            let diff = file_diff(
                &f.store,
                &f.db,
                &source,
                &repo.task_path,
                "same 文件.ts",
                layer,
                &f.token,
            )
            .await
            .unwrap();
            let expected = if layer == "index" {
                format!("+staged-{index}")
            } else {
                format!("+working-{index}")
            };
            assert!(diff.content.contains(&expected));
            assert!(!diff.content.contains("later"));
            assert!(diff.content.contains("--- /dev/null"));
            assert_eq!(diff.path, "same 文件.ts");
        }
    }
    assert!(file_diff(
        &f.store,
        &f.db,
        &source,
        "outside",
        "same 文件.ts",
        "working",
        &f.token
    )
    .await
    .is_err());
    assert!(file_diff(
        &f.store,
        &f.db,
        &source,
        &task.repositories[0].task_path,
        "../outside",
        "working",
        &f.token
    )
    .await
    .is_err());
    assert!(file_diff(
        &f.store,
        &f.db,
        &source,
        &task.repositories[0].task_path,
        "same 文件.ts",
        "invalid",
        &f.token
    )
    .await
    .is_err());
    fs::write(
        Path::new(&task.repositories[0].task_path).join("same 文件.ts"),
        "working-0\n",
    )
    .unwrap();
    let prepared = f.preview(&task, None, false).await;
    let preview_source = CheckpointDiffSource::Preview {
        preview_id: prepared.preview.id.clone(),
    };
    f.db.previews.push(prepared);
    let diff = file_diff(
        &f.store,
        &f.db,
        &preview_source,
        &task.repositories[0].task_path,
        "same 文件.ts",
        "working",
        &f.token,
    )
    .await
    .unwrap();
    assert!(diff.content.contains("-working-0"));
    assert!(diff.content.contains("+++ /dev/null"));
    assert_eq!(diff_task_id(&f.db, &preview_source).unwrap(), task.id);
}

#[tokio::test]
async fn snapshot_diffs_classify_binary_large_and_deleted_files() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    let root = Path::new(&task.repositories[0].task_path);
    fs::write(root.join("binary.bin"), [0, 1, 2]).unwrap();
    fs::write(root.join("invalid.txt"), [0xff, 0xfe]).unwrap();
    fs::write(root.join("large.txt"), vec![b'x'; 5 * 1024 * 1024 + 1]).unwrap();
    fs::remove_file(root.join("file.txt")).unwrap();
    f.end(&task).await;
    let source = CheckpointDiffSource::Checkpoint {
        task_id: task.id.clone(),
        checkpoint_id: f.db.tasks[0].checkpoints.last().unwrap().id.clone(),
    };
    for name in ["binary.bin", "invalid.txt"] {
        let diff = file_diff(
            &f.store,
            &f.db,
            &source,
            &task.repositories[0].task_path,
            name,
            "working",
            &f.token,
        )
        .await
        .unwrap();
        assert!(diff.binary);
        assert!(diff.content.is_empty());
    }
    let diff = file_diff(
        &f.store,
        &f.db,
        &source,
        &task.repositories[0].task_path,
        "large.txt",
        "working",
        &f.token,
    )
    .await
    .unwrap();
    assert!(diff.truncated);
    let diff = file_diff(
        &f.store,
        &f.db,
        &source,
        &task.repositories[0].task_path,
        "file.txt",
        "working",
        &f.token,
    )
    .await
    .unwrap();
    assert!(diff.content.contains("-one"));
    assert!(diff.content.contains("+++ /dev/null"));
}

#[tokio::test]
async fn interrupted_same_chat_resumes_with_one_boundary_and_remains_undoable() {
    let mut f = Fixture::new(3).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "chat", "1")
        .await
        .unwrap();
    for repo in &task.repositories {
        let root = Path::new(&repo.task_path);
        fs::write(root.join("paused.txt"), "staged before pause\n").unwrap();
        git(root, &["add", "paused.txt"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join("paused.txt"), "working before pause\n").unwrap();
    }
    f.send_hook(&task, "Interrupt", "chat", "1").await.unwrap();
    // Interrupt is lightweight; duplicate start events for that old turn do not resume it.
    f.send_hook(&task, "UserPromptSubmit", "chat", "1")
        .await
        .unwrap();
    assert_eq!(
        f.store.read().unwrap().tasks[0].checkpoints[0].status,
        "interrupted"
    );
    assert!(f
        .send_hook(&task, "UserPromptSubmit", "other-chat", "2")
        .await
        .unwrap_err()
        .message
        .contains("Another chat"));
    f.send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .unwrap();
    f.send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .unwrap();
    let db = f.store.read().unwrap();
    let points = &db.tasks[0].checkpoints;
    assert_eq!(points.len(), 2);
    assert_eq!(points[0].status, "completed");
    assert_eq!(points[1].status, "recording");
    assert_eq!(points[0].after.as_deref(), Some(points[1].before.as_str()));
    assert!(db.tasks[0].hook_error.is_none());
    for repo in &task.repositories {
        fs::write(
            Path::new(&repo.task_path).join("resumed.txt"),
            "after resend\n",
        )
        .unwrap();
    }
    f.send_hook(&task, "Stop", "chat", "1").await.unwrap();
    f.send_hook(&task, "Interrupt", "chat", "1").await.unwrap();
    let db = f.store.read().unwrap();
    assert_eq!(db.tasks[0].checkpoints[1].status, "recording");
    assert!(db.tasks[0].checkpoints[1].after.is_none());
    f.send_hook(&task, "Stop", "chat", "2").await.unwrap();
    f.send_hook(&task, "Stop", "chat", "2").await.unwrap();
    f.db = f.store.read().unwrap();
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    for repo in &task.repositories {
        let root = Path::new(&repo.task_path);
        assert!(!root.join("resumed.txt").exists());
        assert_eq!(
            fs::read(root.join("paused.txt")).unwrap(),
            b"working before pause\n"
        );
        assert_eq!(
            git(root, &["show", ":paused.txt"], None, &f.token)
                .await
                .unwrap(),
            b"staged before pause\n"
        );
    }
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    for repo in &task.repositories {
        let root = Path::new(&repo.task_path);
        assert!(!root.join("paused.txt").exists());
        assert!(git(root, &["status", "--porcelain"], None, &f.token)
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn resume_failure_preserves_interrupted_baseline_and_can_be_retried() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "chat", "1")
        .await
        .unwrap();
    let root = Path::new(&task.repositories[0].task_path);
    fs::write(root.join("keep.txt"), "keep paused edits").unwrap();
    f.send_hook(&task, "Interrupt", "chat", "1").await.unwrap();
    let before = f.store.read().unwrap().tasks[0].checkpoints[0]
        .before
        .clone();
    fs::write(root.join(".git/MERGE_HEAD"), "unfinished operation").unwrap();
    assert!(f
        .send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .is_err());
    let db = f.store.read().unwrap();
    assert_eq!(db.tasks[0].checkpoints.len(), 1);
    assert_eq!(db.tasks[0].checkpoints[0].status, "interrupted");
    assert_eq!(db.tasks[0].checkpoints[0].before, before);
    assert!(db.tasks[0].checkpoints[0].after.is_none());
    assert_eq!(
        fs::read(root.join("keep.txt")).unwrap(),
        b"keep paused edits"
    );
    fs::remove_file(root.join(".git/MERGE_HEAD")).unwrap();
    f.send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .unwrap();
    assert_eq!(f.store.read().unwrap().tasks[0].checkpoints.len(), 2);
}

#[tokio::test]
async fn starts_without_interrupt_and_incomplete_or_manual_records_have_specific_errors() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "chat", "1")
        .await
        .unwrap();
    let error = f
        .send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .unwrap_err();
    assert!(error.message.contains("no interruption was recorded"));
    let error = f
        .send_hook(&task, "UserPromptSubmit", "other", "2")
        .await
        .unwrap_err();
    assert!(error.message.contains("Another chat"));
    f.db = f.store.read().unwrap();
    f.db.tasks[0].checkpoints[0].status = "incomplete".into();
    f.store.save(&f.db).unwrap();
    for turn in ["1", "2"] {
        let error = f
            .send_hook(&task, "UserPromptSubmit", "chat", turn)
            .await
            .unwrap_err();
        assert!(error.message.contains("incomplete"));
    }
    f.db.tasks[0].checkpoints[0].session_id = None;
    f.db.tasks[0].checkpoints[0].turn_id = None;
    f.store.save(&f.db).unwrap();
    assert!(f
        .send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .unwrap_err()
        .message
        .contains("manual recording"));
    f.db = f.store.read().unwrap();
    assert_eq!(f.db.tasks[0].checkpoints.len(), 1);
    finish(&f.store, &mut f.db, &task.id, &f.token)
        .await
        .unwrap();
    assert!(f.db.tasks[0].hook_error.is_none());
}

#[tokio::test]
async fn late_stop_after_abandon_does_not_finish_a_new_recording() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "chat", "1")
        .await
        .unwrap();
    f.db = f.store.read().unwrap();
    f.db.tasks[0].checkpoints[0].status = "abandoned".into();
    f.store.save(&f.db).unwrap();
    f.send_hook(&task, "UserPromptSubmit", "chat", "2")
        .await
        .unwrap();
    f.send_hook(&task, "Stop", "chat", "1").await.unwrap();
    f.send_hook(&task, "Interrupt", "chat", "1").await.unwrap();
    let db = f.store.read().unwrap();
    assert_eq!(db.tasks[0].checkpoints[0].status, "abandoned");
    assert_eq!(db.tasks[0].checkpoints[1].status, "recording");
}

#[tokio::test]
async fn resumed_boundary_storage_failure_does_not_complete_the_old_record_in_memory() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "chat", "1")
        .await
        .unwrap();
    f.send_hook(&task, "Interrupt", "chat", "1").await.unwrap();
    f.db = f.store.read().unwrap();
    let original = serde_json::to_vec(&f.db.tasks[0]).unwrap();
    fs::remove_file(f.store.root.join("state.json")).unwrap();
    fs::create_dir(f.store.root.join("state.json")).unwrap();
    assert!(begin(
        &f.store,
        &mut f.db,
        &task.id,
        "resend",
        Some(("chat", "2")),
        None,
        &f.token
    )
    .await
    .is_err());
    assert_eq!(serde_json::to_vec(&f.db.tasks[0]).unwrap(), original);
}

#[test]
fn hook_conflict_messages_follow_application_language() {
    let directory = tempfile::tempdir().unwrap();
    let message = "Another chat has an unfinished recording in this task. Finish that recording first, or use an isolated task workspace for parallel chats.";
    fs::write(
        directory.path().join("state.json"),
        r#"{"settings":{"language":"zhCn"}}"#,
    )
    .unwrap();
    assert!(hook_error_message(Some(directory.path()), message).starts_with("另一个聊天"));
    fs::write(
        directory.path().join("state.json"),
        r#"{"settings":{"language":"en"}}"#,
    )
    .unwrap();
    assert_eq!(hook_error_message(Some(directory.path()), message), message);
    fs::write(
        directory.path().join("state.json"),
        r#"{"language":"zhCn"}"#,
    )
    .unwrap();
    assert!(hook_error_message(Some(directory.path()), message).starts_with("另一个聊天"));
}

#[tokio::test]
async fn cleanup_retains_task_and_recent_undo_without_touching_files_or_index() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    for version in 0..3 {
        f.start(&task).await;
        fs::write(root.join("history.txt"), format!("version {version}\n")).unwrap();
        git(root, &["add", "history.txt"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join("history.txt"), format!("unstaged {version}\n")).unwrap();
        f.end(&task).await;
    }
    let original = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    let original_listing = serde_json::to_vec(&f.db).unwrap();
    let plan = cleanup::preview(&f.store, &f.db, &task.id, 1)
        .unwrap()
        .preview;
    assert_eq!(plan.remove_count, 2);
    assert!(plan.reclaimable_bytes > 0.0);
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), original_listing);
    let size = f.store.size().unwrap();
    let report = cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        1,
        &plan.fingerprint,
        &f.token,
    )
    .unwrap();
    assert_eq!(report.status, "succeeded");
    assert_eq!(report.freed_bytes, plan.reclaimable_bytes);
    assert_eq!(f.store.size().unwrap(), size - report.freed_bytes as u64);
    assert_eq!(f.db.tasks[0].checkpoints.len(), 1);
    assert_eq!(f.store.read().unwrap().tasks[0].id, task.id);
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        original
    );
    f.store.snapshot(&f.db.tasks[0].seed).unwrap();
    let restore = f.preview(&task, None, false).await;
    assert_eq!(f.execute(restore).await.status, "succeeded");
    assert_eq!(fs::read(root.join("history.txt")).unwrap(), b"unstaged 1\n");
    assert_eq!(
        git(root, &["show", ":history.txt"], None, &f.token)
            .await
            .unwrap(),
        b"version 1\n"
    );
}

#[tokio::test]
async fn project_cleanup_deduplicates_usage_and_preserves_other_projects_and_source_state() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    for version in 0..2 {
        f.start(&task).await;
        fs::write(root.join("shared.txt"), format!("shared {version}\n")).unwrap();
        git(root, &["add", "shared.txt"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join("shared.txt"), format!("unstaged {version}\n")).unwrap();
        f.end(&task).await;
    }
    let mut sibling = f.db.tasks[0].clone();
    sibling.id = "sibling".into();
    for point in &mut sibling.checkpoints {
        point.id = format!("sibling-{}", point.id);
    }
    f.db.tasks.push(sibling);
    // A project with the same source roots is still a distinct owner.
    let mut foreign = f.db.tasks[0].clone();
    foreign.id = "foreign".into();
    foreign.workspace_id = "other-project".into();
    for point in &mut foreign.checkpoints {
        point.id = format!("foreign-{}", point.id);
    }
    let foreign_before = serde_json::to_vec(&foreign).unwrap();
    f.db.tasks.push(foreign);
    f.store.save(&f.db).unwrap();
    let before = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    let database_before = serde_json::to_vec(&f.db).unwrap();
    let usage = history::project_storage_usage(&f.store, &f.db, &f.workspace).unwrap();
    assert_eq!(usage.tasks.len(), 2);
    assert_eq!(usage.referenced_bytes, usage.tasks[0].referenced_bytes);
    assert!(
        usage
            .tasks
            .iter()
            .map(|task| task.referenced_bytes)
            .sum::<f64>()
            > usage.referenced_bytes
    );
    let (preview, _) = cleanup::project_preview(&f.store, &f.db, &f.workspace, 0).unwrap();
    assert_eq!(preview.remove_count, 4);
    assert!(preview.reclaimable_bytes < usage.referenced_bytes);
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), database_before);
    let report = cleanup::project_execute(
        &f.store,
        &mut f.db,
        &f.workspace,
        0,
        &preview.fingerprint,
        &f.token,
    )
    .unwrap();
    assert_eq!(report.status, "succeeded");
    assert_eq!(report.freed_bytes, preview.reclaimable_bytes);
    assert!(f.db.tasks[0].checkpoints.is_empty());
    assert!(f.db.tasks[1].checkpoints.is_empty());
    assert_eq!(serde_json::to_vec(&f.db.tasks[2]).unwrap(), foreign_before);
    let snapshot = f
        .store
        .snapshot(f.db.tasks[2].checkpoints[1].after.as_deref().unwrap())
        .unwrap();
    let shared = &snapshot.repositories[0].working["shared.txt"].hash;
    assert_eq!(f.store.get(shared).unwrap(), b"unstaged 1\n");
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        before
    );
}

#[tokio::test]
async fn project_cleanup_preflights_all_tasks_and_rejects_stale_or_cancelled_execution() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    f.end(&task).await;
    let mut sibling = f.db.tasks[0].clone();
    sibling.id = "sibling".into();
    for point in &mut sibling.checkpoints {
        point.id = format!("sibling-{}", point.id);
    }
    f.db.tasks.push(sibling.clone());
    let (preview, _) = cleanup::project_preview(&f.store, &f.db, &f.workspace, 0).unwrap();
    f.start(&sibling).await;
    let before = serde_json::to_vec(&f.db).unwrap();
    assert!(cleanup::project_execute(
        &f.store,
        &mut f.db,
        &f.workspace,
        0,
        &preview.fingerprint,
        &f.token
    )
    .is_err());
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), before);
    let usage = history::project_storage_usage(&f.store, &f.db, &f.workspace).unwrap();
    assert!(usage.reclaimable_bytes.is_none());
    assert_eq!(
        usage
            .tasks
            .iter()
            .find(|task| task.task_id == sibling.id)
            .unwrap()
            .blocked_reason
            .as_deref(),
        Some("Finish the active recording before cleaning checkpoints")
    );
    f.end(&sibling).await;
    assert!(cleanup::project_execute(
        &f.store,
        &mut f.db,
        &f.workspace,
        0,
        &preview.fingerprint,
        &f.token
    )
    .unwrap_err()
    .message
    .contains("stale"));
    let (preview, _) = cleanup::project_preview(&f.store, &f.db, &f.workspace, 0).unwrap();
    let before = serde_json::to_vec(&f.db).unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(cleanup::project_execute(
        &f.store,
        &mut f.db,
        &f.workspace,
        0,
        &preview.fingerprint,
        &cancelled
    )
    .is_err());
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), before);
    f.store.save(&f.db).unwrap();
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let app_before = serde_json::to_vec(&*state.app.read().await).unwrap();
    let usage: ProjectStorageUsage = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::ProjectStorageUsage,
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(usage.tasks.len(), 2);
    assert!(handle(
        &state,
        "missing-project",
        CheckpointAction::ProjectCleanup {
            keep_recent: 0,
            fingerprint: preview.fingerprint.clone()
        },
        &f.token
    )
    .await
    .is_err());
    let result: ProjectCleanupPreview = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::PreviewProjectCleanup { keep_recent: 0 },
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let report: CheckpointCleanupReport = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::ProjectCleanup {
                keep_recent: 0,
                fingerprint: result.fingerprint,
            },
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(report.status, "succeeded");
    assert_eq!(
        serde_json::to_vec(&*state.app.read().await).unwrap(),
        app_before
    );
}

#[tokio::test]
async fn cleanup_blocks_active_recording_and_rejects_stale_preview() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    assert!(cleanup::preview(&f.store, &f.db, &task.id, 0).is_err());
    fs::write(Path::new(&task.path).join("repo-0/new.txt"), "new").unwrap();
    f.end(&task).await;
    let plan = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    f.start(&task).await;
    f.end(&task).await;
    let before = serde_json::to_vec(&f.db).unwrap();
    assert!(cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &plan.fingerprint,
        &f.token
    )
    .unwrap_err()
    .message
    .contains("stale"));
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), before);
    let plan = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    let token = CancellationToken::new();
    token.cancel();
    assert!(cleanup::execute(&f.store, &mut f.db, &task.id, 0, &plan.fingerprint, &token).is_err());
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), before);
}

#[tokio::test]
async fn cleanup_keeps_shared_objects_and_protects_unpublished_worktree_results() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("shared.txt"),
        "shared content",
    )
    .unwrap();
    f.end(&task).await;
    let mut other = f.db.tasks[0].clone();
    other.id = "another-task".into();
    f.db.tasks.push(other.clone());
    let plan = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &plan.fingerprint,
        &f.token,
    )
    .unwrap();
    let snapshot = f
        .store
        .snapshot(other.checkpoints[0].after.as_deref().unwrap())
        .unwrap();
    let shared = &snapshot.repositories[0].working["shared.txt"].hash;
    assert_eq!(f.store.get(shared).unwrap(), b"shared content");
    f.db.tasks[1].isolation = TaskIsolation::Worktree;
    let preview = cleanup::preview(&f.store, &f.db, &other.id, 0)
        .unwrap()
        .preview;
    assert_eq!(preview.remove_count, 0);
    assert_eq!(preview.protected_count, 1);
}

#[tokio::test]
async fn cleanup_keeps_failed_restore_bookkeeping_and_can_recover_after_collection() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("recover.txt"),
        "recover",
    )
    .unwrap();
    f.end(&task).await;
    let prepared = f.preview(&task, None, false).await;
    f.db.transactions.push(Transaction {
        report: RestoreReport {
            id: "failed".into(),
            task_id: task.id.clone(),
            status: "failed".into(),
            completed: 0,
            total: 1,
            error: Some("test failure".into()),
        },
        prepared,
        recovery_before: None,
        recovery_expected: None,
    });
    assert!(cleanup::preview(&f.store, &f.db, &task.id, 0).is_err());
    // A separate task's cleanup must trace the saved pre-operation history too.
    let mut second = task.clone();
    second.id = "other".into();
    f.db.tasks.push(second);
    let plan = cleanup::preview(&f.store, &f.db, "other", 0)
        .unwrap()
        .preview;
    cleanup::execute(&f.store, &mut f.db, "other", 0, &plan.fingerprint, &f.token).unwrap();
    let saved = &f.db.transactions[0].prepared.task_before;
    for point in &saved.checkpoints {
        f.store.snapshot(&point.before).unwrap();
        f.store.snapshot(point.after.as_deref().unwrap()).unwrap();
    }
    assert_eq!(
        apply(&f.store, &mut f.db, 0, true, &f.token)
            .await
            .unwrap()
            .status,
        "recovered"
    );
}

#[tokio::test]
async fn cleanup_keeps_successful_bring_back_reversible() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Worktree).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("result.txt"),
        "result",
    )
    .unwrap();
    f.end(&task).await;
    let prepared = f.preview(&task, None, true).await;
    assert_eq!(f.execute(prepared).await.status, "succeeded");
    let plan = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    assert_eq!(plan.remove_count, 0);
    assert_eq!(plan.protected_count, 2);
    cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &plan.fingerprint,
        &f.token,
    )
    .unwrap();
    assert_eq!(
        apply(&f.store, &mut f.db, 0, true, &f.token)
            .await
            .unwrap()
            .status,
        "recovered"
    );
    assert!(!Path::new(&task.repositories[0].source_path)
        .join("result.txt")
        .exists());
}

#[tokio::test]
async fn cleanup_storage_failure_keeps_history_and_live_objects() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    f.end(&task).await;
    let plan = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    let state = serde_json::to_vec(&f.db).unwrap();
    let size = f.store.size().unwrap();
    fs::remove_file(f.store.root.join("state.json")).unwrap();
    fs::create_dir(f.store.root.join("state.json")).unwrap();
    assert!(cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &plan.fingerprint,
        &f.token
    )
    .is_err());
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), state);
    assert_eq!(f.store.size().unwrap(), size);
}

#[tokio::test]
async fn cleanup_bridge_commands_enforce_workspace_scope_and_keep_task_registered() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("history.txt"),
        "first",
    )
    .unwrap();
    f.end(&task).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("history.txt"),
        "second",
    )
    .unwrap();
    f.end(&task).await;
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let other_root = f.root.join("unrelated");
    fs::create_dir(&other_root).unwrap();
    let other =
        crate::workspace::descriptor(vec![other_root.to_string_lossy().into_owned()]).unwrap();
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(other.clone());
    let action = CheckpointAction::PreviewCleanup {
        task_id: task.id.clone(),
        keep_recent: 0,
    };
    assert!(handle(&state, &other.id, action.clone(), &f.token)
        .await
        .unwrap_err()
        .message
        .contains("does not belong"));
    let preview: CheckpointCleanupPreview = serde_json::from_value(
        handle(&state, &f.workspace.id, action, &f.token)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(preview.remove_count, 2);
    let report: CheckpointCleanupReport = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::Cleanup {
                task_id: task.id.clone(),
                keep_recent: 0,
                fingerprint: preview.fingerprint,
            },
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(report.status, "succeeded");
    let listing: CheckpointListing = serde_json::from_value(
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::Overview,
            &f.token,
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(listing.tasks.len(), 1);
    assert_eq!(listing.tasks[0].id, task.id);
    assert!(listing.tasks[0].checkpoints.is_empty());
    assert_eq!(
        fs::read(Path::new(&task.repositories[0].task_path).join("history.txt")).unwrap(),
        b"second"
    );
}

#[tokio::test]
async fn checkpoint_summaries_deduplicate_layers_and_populate_legacy_history() {
    let mut f = Fixture::new(2).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for repo in &task.repositories {
        let root = Path::new(&repo.task_path);
        fs::write(root.join("地图.ts"), "staged").unwrap();
        git(root, &["add", "地图.ts"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join("地图.ts"), "unstaged").unwrap();
    }
    f.end(&task).await;
    let point = &mut f.db.tasks[0].checkpoints[0];
    assert_eq!(point.summary.as_ref().unwrap().files, 2);
    assert_eq!(
        point.summary.as_ref().unwrap().paths,
        ["repo-0/地图.ts", "repo-1/地图.ts"]
    );
    point.summary = None;
    let before = serde_json::to_vec(&f.db).unwrap();
    let page = history::page(&f.store, &f.db, &task.id, "", None, false, 0, None).unwrap();
    assert_eq!(page.points[0].summary.as_ref().unwrap().files, 2);
    assert_eq!(serde_json::to_vec(&f.db).unwrap(), before);
}

#[tokio::test]
async fn rename_persists_and_preserves_snapshot_identity_and_undo() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("rename.txt"),
        "test",
    )
    .unwrap();
    f.end(&task).await;
    let point = f.db.tasks[0].checkpoints[0].clone();
    rename(&f.store, &mut f.db, &task.id, &point.id, " 修复地图定位 ").unwrap();
    let renamed = &f.store.read().unwrap().tasks[0].checkpoints[0];
    assert_eq!(renamed.id, point.id);
    assert_eq!(renamed.name, "修复地图定位");
    assert_eq!(renamed.before, point.before);
    assert_eq!(renamed.after, point.after);
    for bad in ["", " \n ", "two\nlines", "\u{0000}"] {
        assert!(rename(&f.store, &mut f.db, &task.id, &point.id, bad).is_err());
    }
    assert!(rename(&f.store, &mut f.db, &task.id, &point.id, &"中".repeat(101)).is_err());
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    assert!(!Path::new(&task.repositories[0].task_path)
        .join("rename.txt")
        .exists());
}

#[tokio::test]
async fn automatic_messages_are_exact_lazy_and_preserved_across_interrupt_and_rename() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    let first = format!(
        "\n  修复中文地图定位{}\n\n保留完整消息正文 <script>unsafe()</script>\r\n  保留缩进 🗺️",
        "长".repeat(55)
    );
    let message = |turn: &str, prompt: &str| HookInput {
        session_id: "chat".into(),
        turn_id: Some(turn.into()),
        cwd: task.path.clone(),
        hook_event_name: "UserPromptSubmit".into(),
        prompt: Some(prompt.into()),
    };
    let config = f.store.root.parent().unwrap();
    hook(config, message("1", &first), &f.token).await.unwrap();
    hook(config, message("1", &first), &f.token).await.unwrap();
    f.db = f.store.read().unwrap();
    let point = f.db.tasks[0].checkpoints[0].clone();
    assert_eq!(point.name, prompt::title(&first));
    assert_eq!(point.name.chars().count(), 51);
    assert_eq!(
        prompt::messages(&f.store, &f.db, &task.id, &point.id).unwrap()[0].body,
        first
    );
    let listed =
        serde_json::to_string(&history::overview(&f.store, &f.db, &f.workspace).unwrap()).unwrap();
    assert!(!listed.contains("保留完整消息正文"));
    assert!(!listed.contains("duplicate must not replace original"));
    rename(&f.store, &mut f.db, &task.id, &point.id, "自定义标题").unwrap();
    f.send_hook(&task, "Interrupt", "chat", "1").await.unwrap();
    hook(
        config,
        message("2", "重新编辑的消息\n这是第二轮的正文"),
        &f.token,
    )
    .await
    .unwrap();
    f.send_hook(&task, "Stop", "chat", "2").await.unwrap();
    f.db = f.store.read().unwrap();
    assert_eq!(f.db.tasks[0].checkpoints[0].name, "自定义标题");
    assert_eq!(
        prompt::messages(&f.store, &f.db, &task.id, &point.id).unwrap()[0].body,
        first
    );
    assert_eq!(f.db.tasks[0].checkpoints[1].name, "重新编辑的消息");
    assert_eq!(
        prompt::messages(&f.store, &f.db, &task.id, &f.db.tasks[0].checkpoints[1].id).unwrap()[0]
            .body,
        "重新编辑的消息\n这是第二轮的正文"
    );
    f.store.collect(&f.db).unwrap();
    assert!(f.store.get(point.prompt_hash.as_ref().unwrap()).is_ok());
    let preview = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &preview.fingerprint,
        &f.token,
    )
    .unwrap();
    assert!(f.store.get(point.prompt_hash.as_ref().unwrap()).is_err());
}

#[tokio::test]
async fn message_access_is_scoped_and_shared_messages_survive_cleanup() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    let event = HookInput {
        session_id: "chat".into(),
        turn_id: Some("1".into()),
        cwd: task.path.clone(),
        hook_event_name: "UserPromptSubmit".into(),
        prompt: Some("共享消息\n正文".into()),
    };
    hook(f.store.root.parent().unwrap(), event, &f.token)
        .await
        .unwrap();
    f.send_hook(&task, "Stop", "chat", "1").await.unwrap();
    f.db = f.store.read().unwrap();
    let point = f.db.tasks[0].checkpoints[0].clone();
    let mut other = f.db.tasks[0].clone();
    other.id = "other-task".into();
    f.db.tasks.push(other);
    let preview = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &preview.fingerprint,
        &f.token,
    )
    .unwrap();
    assert_eq!(
        prompt::messages(&f.store, &f.db, "other-task", &point.id).unwrap()[0].body,
        "共享消息\n正文"
    );
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    let foreign_root = f.root.join("foreign");
    fs::create_dir(&foreign_root).unwrap();
    let foreign =
        crate::workspace::descriptor(vec![foreign_root.to_string_lossy().into_owned()]).unwrap();
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(foreign.clone());
    let err = handle(
        &state,
        &foreign.id,
        CheckpointAction::Messages {
            task_id: "other-task".into(),
            checkpoint_id: point.id.clone(),
        },
        &f.token,
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("does not belong"));
}

#[tokio::test]
async fn blocked_or_unregistered_hook_does_not_store_its_message() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "owner", "1")
        .await
        .unwrap();
    let rejected = "message from blocked chat must not be persisted";
    let event = HookInput {
        session_id: "other".into(),
        turn_id: Some("2".into()),
        cwd: task.path.clone(),
        hook_event_name: "UserPromptSubmit".into(),
        prompt: Some(rejected.into()),
    };
    assert!(hook(f.store.root.parent().unwrap(), event, &f.token)
        .await
        .is_err());
    assert!(!f
        .store
        .root
        .join("objects")
        .join(digest(rejected.as_bytes()))
        .exists());
    let unrelated = f.root.join("unregistered");
    fs::create_dir(&unrelated).unwrap();
    let event = HookInput {
        session_id: "other".into(),
        turn_id: Some("3".into()),
        cwd: unrelated.to_string_lossy().into_owned(),
        hook_event_name: "UserPromptSubmit".into(),
        prompt: Some(rejected.into()),
    };
    // The task root includes the project parent; place the unrelated cwd outside it.
    let event = HookInput {
        cwd: f._directory.path().to_string_lossy().into_owned(),
        ..event
    };
    hook(f.store.root.parent().unwrap(), event, &f.token)
        .await
        .unwrap();
    assert!(!f
        .store
        .root
        .join("objects")
        .join(digest(rejected.as_bytes()))
        .exists());
}

#[tokio::test]
async fn history_reads_bypass_capture_and_repository_write_locks() {
    let mut f = Fixture::new(3).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for repo in &task.repositories {
        fs::write(Path::new(&repo.task_path).join("file.txt"), "changed\n").unwrap();
    }
    f.end(&task).await;
    let point = f.db.tasks[0].checkpoints[0].clone();
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let _capture =
        crate::update_worker::repository_lock(&state.config_dir, "checkpoint-storage-v1", &f.token)
            .await
            .unwrap();
    let mut held = Vec::new();
    for repo in &f.repos {
        held.push(state.write_lock(&repo.id).await.lock_owned().await);
    }
    let actions = [
        CheckpointAction::Overview,
        CheckpointAction::Detail {
            task_id: task.id.clone(),
            checkpoint_id: point.id.clone(),
        },
        CheckpointAction::Messages {
            task_id: task.id.clone(),
            checkpoint_id: point.id.clone(),
        },
        CheckpointAction::Diff {
            source: CheckpointDiffSource::Checkpoint {
                task_id: task.id.clone(),
                checkpoint_id: point.id.clone(),
            },
            repository: task.repositories[0].task_path.clone(),
            path: "file.txt".into(),
            layer: "working".into(),
        },
    ];
    for action in actions {
        let start = std::time::Instant::now();
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            handle(&state, &f.workspace.id, action.clone(), &f.token),
        )
        .await
        .expect("history must not wait for capture or repository writers")
        .unwrap();
        eprintln!(
            "checkpoint read while writer locked: {:?} {:?}",
            std::mem::discriminant(&action),
            start.elapsed()
        );
        if matches!(action, CheckpointAction::Detail { .. }) {
            let files: Vec<RestoreFile> = serde_json::from_value(response).unwrap();
            assert_eq!(files.len(), 3);
            assert!(files
                .iter()
                .all(|file| file.before.is_none() && file.after.is_none()));
        }
    }
}

#[tokio::test]
async fn metadata_only_details_do_not_load_file_blobs_but_diff_validates_them() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("file.txt"),
        "changed\n",
    )
    .unwrap();
    f.end(&task).await;
    let point = &f.db.tasks[0].checkpoints[0];
    let after = f.store.snapshot(point.after.as_deref().unwrap()).unwrap();
    let entry = &after.repositories[0].working["file.txt"];
    fs::write(f.store.root.join("objects").join(&entry.hash), "damaged").unwrap();
    let files = details(&f.store, point).unwrap();
    assert_eq!(files.len(), 1);
    assert!(files[0].before.is_none() && files[0].after.is_none());
    let error = file_diff(
        &f.store,
        &f.db,
        &CheckpointDiffSource::Checkpoint {
            task_id: task.id,
            checkpoint_id: point.id.clone(),
        },
        &task.repositories[0].task_path,
        "file.txt",
        "working",
        &f.token,
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("damaged"));
}

#[tokio::test]
async fn cached_legacy_summary_uses_snapshot_identity_without_rewriting_the_database() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("one.txt"),
        "first",
    )
    .unwrap();
    f.end(&task).await;
    let point = &f.db.tasks[0].checkpoints[0];
    let summary = reads::summary(&f.store, point).unwrap();
    let after_path = f
        .store
        .root
        .join("objects")
        .join(point.after.as_deref().unwrap());
    let bytes = fs::read(&after_path).unwrap();
    fs::remove_file(&after_path).unwrap();
    assert_eq!(
        reads::summary(&f.store, point).unwrap().paths,
        summary.paths,
        "the second lookup must not reread manifests"
    );
    fs::write(&after_path, bytes).unwrap();
    let mut changed = point.clone();
    changed.after = Some(changed.before.clone());
    assert_eq!(
        reads::summary(&f.store, &changed).unwrap().files,
        0,
        "a changed snapshot pair invalidates the cache key"
    );
    f.db.tasks[0].checkpoints[0].summary = None;
    f.store.save(&f.db).unwrap();
    let bytes = fs::read(f.store.root.join("state.json")).unwrap();
    let page = history::page(&f.store, &f.db, &task.id, "", None, false, 0, None).unwrap();
    assert_eq!(page.points[0].summary.as_ref().unwrap().files, 1);
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), bytes);
}

#[tokio::test]
async fn cleanup_waits_for_object_readers_and_cancellation_preserves_history() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("file.txt"),
        "changed\n",
    )
    .unwrap();
    f.end(&task).await;
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let preview = cleanup::preview(&f.store, &f.db, &task.id, 0).unwrap();
    let action = CheckpointAction::Cleanup {
        task_id: task.id.clone(),
        keep_recent: 0,
        fingerprint: preview.preview.fingerprint,
    };
    let reader =
        crate::update_worker::repository_read_lock(&state.config_dir, reads::OBJECT_LOCK, &f.token)
            .await
            .unwrap();
    let other_reader =
        crate::update_worker::repository_read_lock(&state.config_dir, reads::OBJECT_LOCK, &f.token)
            .await
            .unwrap();
    let before = fs::read(f.store.root.join("state.json")).unwrap();
    let cancel = CancellationToken::new();
    let (result, ()) = tokio::join!(
        handle(&state, &f.workspace.id, action.clone(), &cancel),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            cancel.cancel();
        }
    );
    assert_eq!(result.unwrap_err().code, "REQUEST_CANCELLED");
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), before);
    assert!(details(&f.store, &f.db.tasks[0].checkpoints[0]).is_ok());
    drop(reader);
    drop(other_reader);
    let report: CheckpointCleanupReport = serde_json::from_value(
        handle(&state, &f.workspace.id, action, &f.token)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(report.status, "succeeded");
    assert!(f.store.read().unwrap().tasks[0].checkpoints.is_empty());
}

#[tokio::test]
async fn task_rename_persists_without_changing_paths_branches_or_checkpoints() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("rename-task.txt"),
        "result",
    )
    .unwrap();
    f.end(&task).await;
    let mut expected = serde_json::to_value(&f.db.tasks[0]).unwrap();
    rename_task(&f.store, &mut f.db, &task.id, "  地图与权限联调 🗺️  ").unwrap();
    expected["name"] = serde_json::json!("地图与权限联调 🗺️");
    assert_eq!(
        serde_json::to_value(&f.store.read().unwrap().tasks[0]).unwrap(),
        expected
    );
    let bytes = fs::read(f.store.root.join("state.json")).unwrap();
    for bad in [
        "",
        "   ",
        "two\nlines",
        "tab\there",
        "nul\0here",
        "control\u{0085}here",
    ] {
        assert!(rename_task(&f.store, &mut f.db, &task.id, bad).is_err());
    }
    assert!(rename_task(&f.store, &mut f.db, &task.id, &"中".repeat(101)).is_err());
    assert!(rename_task(&f.store, &mut f.db, "unknown-task", "valid").is_err());
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), bytes);
    let preview = f.preview(&task, None, false).await;
    assert_eq!(f.execute(preview).await.status, "succeeded");
    assert_eq!(f.db.tasks[0].name, "地图与权限联调 🗺️");
}

#[tokio::test]
async fn task_rename_checks_workspace_and_does_not_wait_for_repository_writers() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    // Renaming during a manual recording is allowed: it only changes display metadata.
    f.start(&task).await;
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    let other_root = f._directory.path().join("other");
    fs::create_dir(&other_root).unwrap();
    let other =
        crate::workspace::descriptor(vec![other_root.to_string_lossy().into_owned()]).unwrap();
    state
        .app
        .write()
        .await
        .recent_workspaces
        .extend([f.workspace.clone(), other.clone()]);
    let action = CheckpointAction::RenameTask {
        task_id: task.id.clone(),
        name: "new task name".into(),
    };
    let before = fs::read(f.store.root.join("state.json")).unwrap();
    assert!(handle(&state, &other.id, action.clone(), &f.token)
        .await
        .unwrap_err()
        .message
        .contains("does not belong"));
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), before);
    let _writer = state.write_lock(&f.repos[0].id).await.lock_owned().await;
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        handle(&state, &f.workspace.id, action, &f.token),
    )
    .await
    .expect("renaming must not wait for a Git writer")
    .unwrap();
    let renamed = &f.store.read().unwrap().tasks[0];
    assert_eq!(renamed.name, "new task name");
    assert_eq!(renamed.checkpoints[0].status, "recording");
}

#[tokio::test]
async fn activity_is_project_scoped_and_reads_metadata_without_snapshot_locks_or_objects() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    for _ in 0..2 {
        f.start(&task).await;
        f.end(&task).await;
    }
    f.start(&task).await;
    // An older interrupted interval must remain visible even if it is not the latest.
    f.db.tasks[0].checkpoints[0].status = "interrupted".into();
    for point in &mut f.db.tasks[0].checkpoints {
        point.before = "missing-snapshot".into();
        point.after = Some("missing-snapshot".into());
        point.summary = None;
    }
    let mut foreign = f.db.tasks[0].clone();
    foreign.id = "foreign".into();
    foreign.workspace_id = "other-workspace".into();
    foreign.path = "/other".into();
    foreign.roots = vec!["/other".into()];
    f.db.tasks.push(foreign);
    f.store.save(&f.db).unwrap();
    let before = fs::read(f.store.root.join("state.json")).unwrap();
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(f.workspace.clone());
    let _capture =
        crate::update_worker::repository_lock(&state.config_dir, "checkpoint-storage-v1", &f.token)
            .await
            .unwrap();
    let _objects =
        crate::update_worker::repository_lock(&state.config_dir, reads::OBJECT_LOCK, &f.token)
            .await
            .unwrap();
    let _writer = state.write_lock(&f.repos[0].id).await.lock_owned().await;
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        handle(
            &state,
            &f.workspace.id,
            CheckpointAction::Activity,
            &f.token,
        ),
    )
    .await
    .expect("activity must not wait for capture, object GC, or Git writes")
    .unwrap();
    let status: CheckpointActivity = serde_json::from_value(response.clone()).unwrap();
    assert_eq!(status.tasks.len(), 1);
    assert_eq!(status.tasks[0].id, task.id);
    assert_eq!(status.tasks[0].checkpoints.len(), 2);
    assert_eq!(status.tasks[0].checkpoints[0].status, "interrupted");
    assert_eq!(status.tasks[0].checkpoints[1].status, "recording");
    assert!(response.get("storageBytes").is_none());
    assert!(response.get("hooksInstalled").is_none());
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), before);
}

#[tokio::test]
async fn additional_messages_share_one_baseline_deduplicate_and_survive_gc() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    let config = f.store.root.parent().unwrap().to_path_buf();
    let input = |prompt: &str| HookInput {
        session_id: "chat".into(),
        turn_id: Some("one".into()),
        cwd: task.path.clone(),
        hook_event_name: "UserPromptSubmit".into(),
        prompt: Some(prompt.into()),
    };
    hook(&config, input("first message"), &f.token)
        .await
        .unwrap();
    let before = f.store.read().unwrap().tasks[0].checkpoints[0]
        .before
        .clone();
    fs::write(
        Path::new(&task.repositories[0].task_path).join("extra"),
        "change",
    )
    .unwrap();
    hook(&config, input("追加消息\n保留全文"), &f.token)
        .await
        .unwrap();
    hook(&config, input("追加消息\n保留全文"), &f.token)
        .await
        .unwrap();
    f.db = f.store.read().unwrap();
    assert_eq!(f.db.tasks[0].checkpoints.len(), 1);
    let point = &f.db.tasks[0].checkpoints[0];
    assert_eq!(point.before, before);
    assert_eq!(f.db.additional_messages[&point.id].len(), 1);
    let messages = prompt::messages(&f.store, &f.db, &task.id, &point.id).unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|message| message.body.as_str())
            .collect::<Vec<_>>(),
        ["first message", "追加消息\n保留全文"]
    );
    assert!(!f.db.verified_hooks.contains_key(&task.id));
    f.send_hook(&task, "Stop", "chat", "one").await.unwrap();
    f.db = f.store.read().unwrap();
    assert!(f.db.verified_hooks.contains_key(&task.id));
    let extra = f.db.additional_messages[&f.db.tasks[0].checkpoints[0].id][0].clone();
    f.store.collect(&f.db).unwrap();
    assert!(f.store.get(&extra).is_ok());
}

#[tokio::test]
async fn unrelated_stop_and_manual_finish_cannot_verify_hooks() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    f.send_hook(&task, "UserPromptSubmit", "chat", "one")
        .await
        .unwrap();
    assert!(f
        .send_hook(&task, "Stop", "chat", "different")
        .await
        .is_err());
    f.db = f.store.read().unwrap();
    assert!(f.db.verified_hooks.is_empty());
    finish(&f.store, &mut f.db, &task.id, &f.token)
        .await
        .unwrap();
    assert!(f.store.read().unwrap().verified_hooks.is_empty());
}

#[tokio::test]
async fn opening_codex_rejects_a_task_owned_by_another_project_without_launching() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let other = Fixture::new(1).await;
    let state = AppState::load(f.store.root.parent().unwrap().to_path_buf());
    state
        .app
        .write()
        .await
        .recent_workspaces
        .push(other.workspace.clone());
    let before = fs::read(f.store.root.join("state.json")).unwrap();
    let error = handle(
        &state,
        &other.workspace.id,
        CheckpointAction::OpenInCodex { task_id: task.id },
        &f.token,
    )
    .await
    .unwrap_err();
    assert!(error
        .message
        .contains("Task does not belong to this workspace"));
    assert_eq!(fs::read(f.store.root.join("state.json")).unwrap(), before);
}

#[tokio::test]
async fn redo_listing_identifies_only_the_latest_undo_range() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    let root = Path::new(&task.repositories[0].task_path);
    for name in ["first", "second", "third"] {
        f.start(&task).await;
        fs::write(root.join(name), name).unwrap();
        f.end(&task).await;
    }
    let ids = f.db.tasks[0]
        .checkpoints
        .iter()
        .map(|point| point.id.clone())
        .collect::<Vec<_>>();
    let undo = f.preview(&task, None, false).await;
    f.execute(undo).await;
    assert_eq!(redo::checkpoints(&f.db, &f.workspace)[&task.id], ids[2..]);
    let undo = f.preview(&task, Some(&ids[0]), false).await;
    f.execute(undo).await;
    let overview = history::overview(&f.store, &f.db, &f.workspace).unwrap();
    assert_eq!(overview.redo_checkpoints.unwrap()[&task.id], ids[..2]);
    let mut unrelated = f.workspace.clone();
    unrelated.id = "unrelated-project".into();
    unrelated.paths.clear();
    assert!(redo::checkpoints(&f.db, &unrelated).is_empty());
    let redo = redo::prepare_redo(&f.store, &f.db, &f.db.tasks[0], &f.token)
        .await
        .unwrap();
    f.execute(redo).await;
    assert!(redo::checkpoints(&f.db, &f.workspace).is_empty());
    assert!(root.join("first").exists());
    assert!(root.join("second").exists());
    assert!(!root.join("third").exists());
}

#[tokio::test]
async fn redo_merges_later_edits_and_restores_all_repositories_and_index() {
    let mut f = Fixture::new(3).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for repo in &task.repositories {
        let root = Path::new(&repo.task_path);
        fs::write(
            root.join("file.txt"),
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
        )
        .unwrap();
        git(root, &["add", "file.txt"], None, &f.token)
            .await
            .unwrap();
        fs::write(root.join("new.bin"), b"binary\0bytes").unwrap();
    }
    f.end(&task).await;
    let undo = f.preview(&task, None, false).await;
    f.execute(undo).await;
    for repo in &task.repositories {
        let path = Path::new(&repo.task_path).join("file.txt");
        fs::write(
            &path,
            fs::read_to_string(&path).unwrap().replace("ten\n", "TEN\n"),
        )
        .unwrap();
    }
    let redo = redo::prepare_redo(&f.store, &f.db, &f.db.tasks[0], &f.token)
        .await
        .unwrap();
    assert!(redo.preview.redo_of.is_some());
    assert!(redo.preview.conflicts.is_empty());
    assert_eq!(f.execute(redo).await.status, "succeeded");
    for repo in &task.repositories {
        let root = Path::new(&repo.task_path);
        let text = fs::read_to_string(root.join("file.txt")).unwrap();
        assert!(text.starts_with("ONE\n") && text.ends_with("TEN\n"));
        assert_eq!(fs::read(root.join("new.bin")).unwrap(), b"binary\0bytes");
        assert!(String::from_utf8(
            git(root, &["show", ":file.txt"], None, &f.token)
                .await
                .unwrap()
        )
        .unwrap()
        .starts_with("ONE\n"));
    }
    assert_eq!(f.db.tasks[0].checkpoints[0].status, "completed");
    assert!(redo::candidate(&f.db, &f.db.tasks[0]).is_none());
}

#[tokio::test]
async fn redo_conflicts_are_batch_preflight_and_partial_failure_can_recover() {
    let mut f = Fixture::new(2).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    for repo in &task.repositories {
        fs::write(Path::new(&repo.task_path).join("new"), "result").unwrap();
    }
    f.end(&task).await;
    let undo = f.preview(&task, None, false).await;
    f.execute(undo).await;
    let root = Path::new(&task.repositories[1].task_path);
    fs::write(root.join("new"), "later conflict").unwrap();
    let before = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    let blocked = redo::prepare_redo(&f.store, &f.db, &f.db.tasks[0], &f.token)
        .await
        .unwrap();
    assert!(!blocked.preview.conflicts.is_empty());
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        before
    );
    fs::remove_file(root.join("new")).unwrap();
    let before = capture(&f.store, &paths(&task), &f.token).await.unwrap();
    let redo = redo::prepare_redo(&f.store, &f.db, &f.db.tasks[0], &f.token)
        .await
        .unwrap();
    fs::write(f.store.root.join("test-fail-after-write"), "").unwrap();
    let report = f.execute(redo).await;
    assert_eq!(report.status, "failed");
    fs::remove_file(f.store.root.join("test-fail-after-write")).unwrap();
    let index = f.db.transactions.len() - 1;
    assert_eq!(
        apply(&f.store, &mut f.db, index, true, &f.token)
            .await
            .unwrap()
            .status,
        "recovered"
    );
    assert_eq!(
        capture(&f.store, &paths(&task), &f.token).await.unwrap(),
        before
    );
    assert_eq!(f.db.tasks[0].checkpoints[0].status, "undone");
}

#[tokio::test]
async fn paged_history_searches_appended_messages_and_counts_hidden_later_turns() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    f.end(&task).await;
    let prototype = f.db.tasks[0].checkpoints[0].clone();
    f.db.tasks[0].checkpoints = (0..123)
        .map(|n| {
            let mut p = prototype.clone();
            p.id = format!("point-{n}");
            p.name = format!("change {n}");
            p
        })
        .collect();
    let extra = f.store.put("追加的中文检索词".as_bytes()).unwrap();
    f.db.additional_messages
        .insert("point-3".into(), vec![extra]);
    let page = history::page(&f.store, &f.db, &task.id, "", None, false, 50, None).unwrap();
    assert_eq!(page.points.len(), 50);
    assert_eq!(page.total, 123);
    assert_eq!(page.offset, 50);
    assert_eq!(page.points[0].id, "point-72");
    assert_eq!(page.following_turns["point-72"], 50);
    let search =
        history::page(&f.store, &f.db, &task.id, "中文检索", None, false, 0, None).unwrap();
    assert_eq!(search.matching, 1);
    assert_eq!(search.points[0].id, "point-3");
    assert_eq!(
        history::page(
            &f.store,
            &f.db,
            &task.id,
            "",
            None,
            false,
            50,
            Some("stale")
        )
        .unwrap()
        .offset,
        0
    );
    let overview = history::overview(&f.store, &f.db, &f.workspace).unwrap();
    assert_eq!(overview.history_counts.unwrap()[&task.id], 123);
    assert!(overview.tasks[0].checkpoints.len() <= 2);
}

#[tokio::test]
async fn connection_checks_command_target_and_same_round_verification() {
    let mut f = Fixture::new(1).await;
    let task = f.automatic_task().await;
    let target = f._directory.path().join("hooks.json");
    let executable = f._directory.path().join("VersionDock app");
    fs::write(&executable, "test executable").unwrap();
    install_hooks_at(f.store.root.parent().unwrap(), &target, &executable).unwrap();
    assert!(hooks_installed_at(&target, f.store.root.parent().unwrap(), &executable).unwrap());
    let another = f._directory.path().join("missing app");
    assert!(!hooks_installed_at(&target, f.store.root.parent().unwrap(), &another).unwrap());
    let mut config: serde_json::Value =
        serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    config["hooks"]["Stop"][0]["hooks"][0]["command"] =
        serde_json::json!("missing --versiondock-checkpoint-hook anywhere");
    fs::write(&target, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(!hooks_installed_at(&target, f.store.root.parent().unwrap(), &executable).unwrap());
    f.db.tasks[0].hook_events = vec!["UserPromptSubmit".into(), "Stop".into()];
    assert!(f.db.verified_hooks.is_empty());
    f.db.tasks[0].mode = RecordingMode::Manual;
    let connections = connections::all(&f.db, &f.workspace, f.store.root.parent().unwrap());
    assert_eq!(connections[&task.id].status, "manual");
}

#[tokio::test]
async fn storage_accounting_is_global_but_task_references_and_redo_backup_are_protected() {
    let mut f = Fixture::new(1).await;
    let task = f.task(TaskIsolation::Original).await;
    f.start(&task).await;
    fs::write(
        Path::new(&task.repositories[0].task_path).join("new"),
        "result",
    )
    .unwrap();
    f.end(&task).await;
    let undo = f.preview(&task, None, false).await;
    f.execute(undo).await;
    let usage = history::storage_usage(&f.store, &f.db, Some(&task.id)).unwrap();
    assert!(usage.task_bytes > 0.0 && usage.task_bytes <= usage.total_bytes);
    assert_eq!(usage.path, f.store.root.to_string_lossy());
    let preview = cleanup::preview(&f.store, &f.db, &task.id, 0)
        .unwrap()
        .preview;
    assert_eq!(preview.remove_count, 0);
    cleanup::execute(
        &f.store,
        &mut f.db,
        &task.id,
        0,
        &preview.fingerprint,
        &f.token,
    )
    .unwrap();
    let redo = redo::prepare_redo(&f.store, &f.db, &f.db.tasks[0], &f.token)
        .await
        .unwrap();
    assert_eq!(f.execute(redo).await.status, "succeeded");
    let global = history::storage_usage(&f.store, &f.db, None).unwrap();
    assert!(global.total_bytes > 0.0);
    assert_eq!(global.task_bytes, 0.0);
}
