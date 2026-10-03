use super::*;
use std::process::Command;
fn run(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn fixture() -> (tempfile::TempDir, RepositoryMeta) {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &["init", "-b", "main"]);
    run(dir.path(), &["config", "user.name", "AI Fixture"]);
    run(
        dir.path(),
        &["config", "user.email", "ai-fixture@example.invalid"],
    );
    std::fs::write(dir.path().join("selected.txt"), "before\n").unwrap();
    std::fs::write(dir.path().join("outside.txt"), "outside before\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "initial"]);
    let repo = RepositoryMeta {
        id: uuid::Uuid::new_v4().to_string(),
        name: "AI fixture".into(),
        root_path: dir.path().to_string_lossy().into(),
        color: "#000".into(),
        kind: VcsKind::Git,
        parent_repo_id: None,
        depth: 0,
        is_submodule: false,
        is_worktree: false,
    };
    (dir, repo)
}
fn plan(source: &AiComposerSource) -> Vec<AiGroup> {
    source
        .units
        .iter()
        .enumerate()
        .map(|(n, u)| AiGroup {
            id: format!("g{n}"),
            message: format!("fix(fixture): apply group {n}"),
            rationale: String::new(),
            unit_ids: vec![u.id.clone()],
        })
        .collect()
}
#[tokio::test]
async fn working_apply_preserves_outside_index_worktree_and_backup() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("selected.txt"), "selected after\n").unwrap();
    std::fs::write(dir.path().join("outside.txt"), "outside staged\n").unwrap();
    run(dir.path(), &["add", "outside.txt"]);
    std::fs::write(dir.path().join("outside.txt"), "outside unstaged\n").unwrap();
    let old = run(dir.path(), &["rev-parse", "HEAD"]);
    let source = prepare("w", &repo, &["selected.txt".into()], false, &[], &token)
        .await
        .unwrap();
    let result = apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        true,
        None,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        run(dir.path(), &["show", "HEAD:selected.txt"]),
        "selected after"
    );
    assert_eq!(run(dir.path(), &["show", ":outside.txt"]), "outside staged");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("outside.txt")).unwrap(),
        "outside unstaged\n"
    );
    assert_eq!(
        run(
            dir.path(),
            &["rev-parse", result.backup_ref.as_ref().unwrap()]
        ),
        old
    );
    assert_eq!(
        run(dir.path(), &["diff", "--cached", "--name-only"]),
        "outside.txt"
    );
    assert_eq!(
        run(dir.path(), &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        1
    );
}
#[tokio::test]
async fn staged_apply_keeps_unstaged_selected_content() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("selected.txt"), "stage\n").unwrap();
    run(dir.path(), &["add", "selected.txt"]);
    std::fs::write(dir.path().join("selected.txt"), "working\n").unwrap();
    let source = prepare("w", &repo, &["selected.txt".into()], true, &[], &token)
        .await
        .unwrap();
    apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        true,
        None,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(run(dir.path(), &["show", "HEAD:selected.txt"]), "stage");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("selected.txt")).unwrap(),
        "working\n"
    );
}
#[tokio::test]
async fn changed_plan_is_rejected_without_moving_head() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("selected.txt"), "after\n").unwrap();
    let source = prepare("w", &repo, &["selected.txt".into()], false, &[], &token)
        .await
        .unwrap();
    let head = run(dir.path(), &["rev-parse", "HEAD"]);
    std::fs::write(dir.path().join("selected.txt"), "later\n").unwrap();
    let e = apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        true,
        None,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, "AI_COMPOSER_STALE");
    assert_eq!(run(dir.path(), &["rev-parse", "HEAD"]), head);
}
#[tokio::test]
async fn ignored_tracked_literal_paths_and_binary_rename_are_atomic() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("literal[1].txt"), "before\n").unwrap();
    std::fs::write(dir.path().join("image.bin"), [0u8, 1, 2]).unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "files"]);
    std::fs::write(dir.path().join(".gitignore"), "literal*\n").unwrap();
    run(dir.path(), &["add", ".gitignore"]);
    run(dir.path(), &["commit", "-m", "ignore"]);
    std::fs::write(dir.path().join("literal[1].txt"), "after\n").unwrap();
    run(dir.path(), &["mv", "image.bin", "renamed.bin"]);
    let source = prepare(
        "w",
        &repo,
        &["literal[1].txt".into(), "renamed.bin".into()],
        false,
        &[],
        &token,
    )
    .await
    .unwrap();
    assert!(source
        .units
        .iter()
        .any(|u| u.status == "renamed" && u.atomic));
    apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        true,
        None,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(run(dir.path(), &["status", "--porcelain"]), "");
    assert_eq!(run(dir.path(), &["show", "HEAD:literal[1].txt"]), "after");
}
#[tokio::test]
async fn history_reorganization_preserves_tree_and_rejects_pushed_history() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("selected.txt"), "first\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "first"]);
    let first = run(dir.path(), &["rev-parse", "HEAD"]);
    std::fs::write(dir.path().join("outside.txt"), "second\n").unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "second"]);
    let second = run(dir.path(), &["rev-parse", "HEAD"]);
    let tree = run(dir.path(), &["rev-parse", "HEAD^{tree}"]);
    let source = prepare(
        "w",
        &repo,
        &[],
        false,
        &[first.clone(), second.clone()],
        &token,
    )
    .await
    .unwrap();
    let result = apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        true,
        None,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(run(dir.path(), &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(run(dir.path(), &["status", "--porcelain"]), "");
    assert!(result.backup_ref.is_some());
    run(
        dir.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let head = run(dir.path(), &["rev-parse", "HEAD"]);
    assert_eq!(
        prepare("w", &repo, &[], false, &[head], &token)
            .await
            .unwrap_err()
            .code,
        "AI_COMPOSER_PUSHED"
    );
}
#[cfg(unix)]
#[tokio::test]
async fn hook_modifying_original_index_prevents_publication() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("selected.txt"), "after\n").unwrap();
    let source = prepare("w", &repo, &["selected.txt".into()], false, &[], &token)
        .await
        .unwrap();
    let old = run(dir.path(), &["rev-parse", "HEAD"]);
    let hook = dir.path().join(".git/hooks/pre-commit");
    std::fs::write(&hook,format!("#!/bin/sh\nunset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE\nprintf 'external\\n' > '{}/outside.txt'\ngit -C '{}' add outside.txt\n",dir.path().display(),dir.path().display())).unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        apply(
            session(&source.session_id, "w", &repo.id).unwrap(),
            plan(&source),
            false,
            None,
            &token
        )
        .await
        .unwrap_err()
        .code,
        "AI_COMPOSER_STALE"
    );
    assert_eq!(run(dir.path(), &["rev-parse", "HEAD"]), old);
    assert_eq!(run(dir.path(), &["show", ":outside.txt"]), "external");
}

#[tokio::test]
async fn hunks_can_be_reordered_and_use_application_identity() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    let original = (0..50).map(|n| format!("line {n}\n")).collect::<String>();
    std::fs::write(dir.path().join("selected.txt"), &original).unwrap();
    run(dir.path(), &["add", "."]);
    run(dir.path(), &["commit", "-m", "lines"]);
    let updated = original
        .replace("line 1\n", "changed one\nextra line\n")
        .replace("line 45\n", "changed later\n");
    std::fs::write(dir.path().join("selected.txt"), &updated).unwrap();
    let source = prepare("w", &repo, &["selected.txt".into()], false, &[], &token)
        .await
        .unwrap();
    assert_eq!(source.units.len(), 2);
    let mut groups = plan(&source);
    groups.reverse();
    let identity = crate::models::EffectiveGitIdentity {
        user_name: "App Identity".into(),
        email: "app@example.invalid".into(),
        source: crate::models::GitIdentitySource::Global,
        profile_id: None,
        valid: true,
    };
    apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        groups,
        true,
        Some(&identity),
        &token,
    )
    .await
    .unwrap();
    assert_eq!(run(dir.path(), &["status", "--porcelain"]), "");
    assert_eq!(
        run(dir.path(), &["log", "-1", "--format=%an <%ae>"]),
        "App Identity <app@example.invalid>"
    );
}
#[tokio::test]
async fn svn_file_groups_commit_to_a_real_local_repository() {
    let dir = tempfile::tempdir().unwrap();
    let repository = dir.path().join("svnrepo");
    let working = dir.path().join("wc");
    let svn = |args: &[String]| {
        let out = Command::new("svn").args(args).output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    assert!(Command::new("svnadmin")
        .arg("create")
        .arg(&repository)
        .status()
        .unwrap()
        .success());
    svn(&[
        "checkout".into(),
        format!("file://{}", repository.display()),
        working.to_string_lossy().into(),
    ]);
    for path in ["a.txt", "b.txt"] {
        std::fs::write(working.join(path), "before\n").unwrap();
        svn(&["add".into(), working.join(path).to_string_lossy().into()]);
    }
    svn(&[
        "commit".into(),
        "-m".into(),
        "initial".into(),
        working.to_string_lossy().into(),
    ]);
    for path in ["a.txt", "b.txt"] {
        std::fs::write(working.join(path), "after\n").unwrap();
    }
    let repo = RepositoryMeta {
        id: uuid::Uuid::new_v4().to_string(),
        name: "SVN fixture".into(),
        root_path: working.to_string_lossy().into(),
        kind: VcsKind::Svn,
        color: "#000".into(),
        parent_repo_id: None,
        depth: 0,
        is_worktree: false,
        is_submodule: false,
    };
    let token = CancellationToken::new();
    let source = prepare(
        "w",
        &repo,
        &["a.txt".into(), "b.txt".into()],
        false,
        &[],
        &token,
    )
    .await
    .unwrap();
    let result = apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        false,
        None,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(result.completed_groups, Some(2));
    assert_eq!(
        svn(&["status".into(), working.to_string_lossy().into()]).trim(),
        ""
    );
}

#[tokio::test]
async fn another_git_clients_index_lock_is_never_removed() {
    let (dir, repo) = fixture();
    let token = CancellationToken::new();
    std::fs::write(dir.path().join("selected.txt"), "after\n").unwrap();
    let source = prepare("w", &repo, &["selected.txt".into()], false, &[], &token)
        .await
        .unwrap();
    let old = run(dir.path(), &["rev-parse", "HEAD"]);
    let lock = dir.path().join(".git/index.lock");
    std::fs::write(&lock, "external-client-lock").unwrap();
    let err = apply(
        session(&source.session_id, "w", &repo.id).unwrap(),
        plan(&source),
        true,
        None,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "AI_COMPOSER_INDEX_LOCKED");
    assert_eq!(
        std::fs::read_to_string(lock).unwrap(),
        "external-client-lock"
    );
    assert_eq!(run(dir.path(), &["rev-parse", "HEAD"]), old);
}

#[test]
fn split_patch_retains_rename_source_and_counts_marker_like_code() {
    let patch = "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n---old code\n+++new code\n";
    let (units, _) = split_patch(patch, &["new.txt".into()]);
    assert_eq!(units[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!(units[0].status, "renamed");
    assert!(units[0].atomic);
    assert_eq!((units[0].added, units[0].removed), (1, 1));
    let group = AiGroup {
        id: " ".into(),
        message: "msg".into(),
        rationale: String::new(),
        unit_ids: vec![units[0].id.clone()],
    };
    assert!(validate_groups(&[group], &units).is_err());
}

#[test]
fn rename_metadata_decodes_git_quoted_utf8_and_literal_quotes() {
    assert_eq!(
        decode_patch_path(r#""\344\270\255\346\226\207\t\".txt""#),
        "中文\t\".txt"
    );
    assert_eq!(
        decode_patch_path("path with spaces.txt"),
        "path with spaces.txt"
    );
}
