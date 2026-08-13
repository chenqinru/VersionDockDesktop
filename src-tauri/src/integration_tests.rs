use std::{path::Path, process::Command};

use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

use crate::{
    models::{
        BranchOperation, ConflictChoice, RemoteOperation, RepositoryMeta, StashOperation,
        SubtreeOperation, SubtreeState, SyncAction, TagOperation, VcsKind,
    },
    shelf, vcs, workspace,
};

fn available(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .output()
        .map(|value| value.status.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn real_git_branch_compare_and_remote_management() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let directory = tempdir().unwrap();
    let remote = tempdir().unwrap();
    command("git", &["init", "--bare"], remote.path());
    command("git", &["init", "-b", "main"], directory.path());
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        directory.path(),
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.test"],
        directory.path(),
    );
    std::fs::write(directory.path().join("shared.txt"), "base\n").unwrap();
    command("git", &["add", "shared.txt"], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    command(
        "git",
        &["switch", "-c", "feature/compare"],
        directory.path(),
    );
    std::fs::write(directory.path().join("shared.txt"), "base\nfeature\n").unwrap();
    std::fs::write(directory.path().join("feature.txt"), "feature\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "feature change"], directory.path());
    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("main.txt"), "main\n").unwrap();
    command("git", &["add", "main.txt"], directory.path());
    command("git", &["commit", "-m", "main change"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let comparison = vcs::branch_compare(&repository, "main", "feature/compare", &token)
        .await
        .unwrap();
    assert_eq!(comparison.base_commits.len(), 1);
    assert_eq!(comparison.target_commits.len(), 1);
    assert!(comparison
        .files
        .iter()
        .any(|file| file.path == "feature.txt"));
    assert!(
        vcs::branch_compare(&repository, "--output=/tmp/escape", "main", &token)
            .await
            .is_err()
    );

    vcs::remote_operation(
        &repository,
        RemoteOperation::Add {
            name: "secure".into(),
            url: "https://user:secret@example.test/repository.git".into(),
        },
        &token,
    )
    .await
    .unwrap();
    let listed = vcs::remotes(&repository, &token).await.unwrap();
    assert_eq!(
        listed[0].fetch_url,
        "https://<redacted>@example.test/repository.git"
    );
    vcs::remote_operation(
        &repository,
        RemoteOperation::SetUrl {
            name: "secure".into(),
            url: remote.path().to_string_lossy().into_owned(),
            push: false,
        },
        &token,
    )
    .await
    .unwrap();
    vcs::remote_operation(
        &repository,
        RemoteOperation::Rename {
            old_name: "secure".into(),
            new_name: "origin".into(),
        },
        &token,
    )
    .await
    .unwrap();
    vcs::remote_operation(
        &repository,
        RemoteOperation::Prune {
            name: "origin".into(),
        },
        &token,
    )
    .await
    .unwrap();
    vcs::remote_operation(
        &repository,
        RemoteOperation::Remove {
            name: "origin".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::remotes(&repository, &token).await.unwrap().is_empty());
    assert!(vcs::remote_operation(
        &repository,
        RemoteOperation::Add {
            name: "bad".into(),
            url: "https://example.test/repo\n--upload-pack=evil".into(),
        },
        &token,
    )
    .await
    .is_err());
}

#[tokio::test]
async fn real_git_discard_restores_tracked_and_removes_untracked_files() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let directory = tempdir().unwrap();
    command("git", &["init", "-b", "main"], directory.path());
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        directory.path(),
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.test"],
        directory.path(),
    );
    std::fs::write(directory.path().join("tracked.txt"), "original\n").unwrap();
    command("git", &["add", "tracked.txt"], directory.path());
    command("git", &["commit", "-m", "initial"], directory.path());
    std::fs::write(directory.path().join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(directory.path().join("untracked.txt"), "temporary\n").unwrap();

    let repository = repo(directory.path(), VcsKind::Git);
    vcs::discard(
        &repository,
        &["tracked.txt".into(), "untracked.txt".into()],
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(
        std::fs::read_to_string(directory.path().join("tracked.txt")).unwrap(),
        "original\n"
    );
    assert!(!directory.path().join("untracked.txt").exists());
}

#[tokio::test]
async fn real_git_lists_only_unpushed_commits() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let directory = tempdir().unwrap();
    let remote = tempdir().unwrap();
    command("git", &["init", "--bare"], remote.path());
    command("git", &["init", "-b", "main"], directory.path());
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        directory.path(),
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.test"],
        directory.path(),
    );
    std::fs::write(directory.path().join("base.txt"), "base\n").unwrap();
    command("git", &["add", "base.txt"], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    command(
        "git",
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
        directory.path(),
    );
    command(
        "git",
        &["push", "--set-upstream", "origin", "main"],
        directory.path(),
    );
    std::fs::write(directory.path().join("local.txt"), "one\ntwo\n").unwrap();
    command("git", &["add", "local.txt"], directory.path());
    command("git", &["commit", "-m", "local only"], directory.path());

    let commits = vcs::unpushed_commits(
        &repo(directory.path(), VcsKind::Git),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].message, "local only");
    assert_eq!(commits[0].files_changed, 1);
    assert_eq!(commits[0].additions, 2);
}

fn command(program: &str, args: &[&str], cwd: &Path) {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{program} {:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repo(path: &Path, kind: VcsKind) -> RepositoryMeta {
    RepositoryMeta {
        id: "integration".into(),
        name: "integration".into(),
        root_path: path.to_string_lossy().into_owned(),
        color: "#4EC9B0".into(),
        kind,
        parent_repo_id: None,
        depth: 0,
        is_submodule: false,
        is_worktree: false,
    }
}

#[tokio::test]
async fn real_git_subtree_registry_and_operations() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let parent = tempdir().unwrap();
    let source = tempdir().unwrap();
    let bare_remote = tempdir().unwrap();
    command("git", &["init", "-b", "main"], parent.path());
    command("git", &["init", "-b", "main"], source.path());
    command("git", &["init", "--bare"], bare_remote.path());
    for directory in [parent.path(), source.path()] {
        command(
            "git",
            &["config", "user.name", "VersionDock Test"],
            directory,
        );
        command(
            "git",
            &["config", "user.email", "versiondock@example.test"],
            directory,
        );
    }
    std::fs::write(parent.path().join("README.md"), "parent\n").unwrap();
    command("git", &["add", "README.md"], parent.path());
    command("git", &["commit", "-m", "parent initial"], parent.path());
    std::fs::write(source.path().join("library.txt"), "one\n").unwrap();
    command("git", &["add", "library.txt"], source.path());
    command("git", &["commit", "-m", "source initial"], source.path());
    command(
        "git",
        &[
            "remote",
            "add",
            "origin",
            bare_remote.path().to_str().unwrap(),
        ],
        source.path(),
    );
    command(
        "git",
        &["push", "--set-upstream", "origin", "main"],
        source.path(),
    );
    command(
        "git",
        &[
            "remote",
            "add",
            "subtree-source",
            bare_remote.path().to_str().unwrap(),
        ],
        parent.path(),
    );

    let repository = repo(parent.path(), VcsKind::Git);
    let token = CancellationToken::new();
    assert!(vcs::subtree_operation(
        &repository,
        SubtreeOperation::Add {
            prefix: "vendor/failed".into(),
            remote: "subtree-source".into(),
            branch: "missing-branch".into(),
            squash: true,
        },
        &token,
    )
    .await
    .is_err());
    assert!(vcs::subtrees(&repository, &token).await.unwrap().is_empty());
    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Add {
            prefix: "vendor/library".into(),
            remote: "subtree-source".into(),
            branch: "main".into(),
            squash: true,
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(parent.path().join("vendor/library/library.txt")).unwrap(),
        "one\n"
    );
    let entries = vcs::subtrees(&repository, &token).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].prefix, "vendor/library");
    assert_eq!(entries[0].remote, "subtree-source");
    assert!(entries[0].squash);
    let id = entries[0].id.clone();
    let config = Command::new("git")
        .args([
            "config",
            "--local",
            "--get",
            &format!("versiondock.subtree.{id}.prefix"),
        ])
        .current_dir(parent.path())
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&config.stdout).trim(),
        "vendor/library"
    );

    std::fs::write(source.path().join("library.txt"), "one\ntwo\n").unwrap();
    command("git", &["add", "library.txt"], source.path());
    command("git", &["commit", "-m", "source update"], source.path());
    command("git", &["push", "origin", "main"], source.path());
    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Pull {
            subtree_id: id.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(parent.path().join("vendor/library/library.txt")).unwrap(),
        "one\ntwo\n"
    );
    command(
        "git",
        &["remote", "remove", "subtree-source"],
        parent.path(),
    );
    let error = vcs::subtree_operation(
        &repository,
        SubtreeOperation::Push {
            subtree_id: id.clone(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "SUBTREE_REMOTE_NOT_FOUND");
    command(
        "git",
        &[
            "remote",
            "add",
            "subtree-source",
            bare_remote.path().to_str().unwrap(),
        ],
        parent.path(),
    );

    command(
        "git",
        &[
            "config",
            "--local",
            &format!("versiondock.subtree.{id}.state"),
            "pending",
        ],
        parent.path(),
    );
    let pending = vcs::subtrees(&repository, &token).await.unwrap();
    assert_eq!(pending[0].state, SubtreeState::Pending);
    let error = vcs::subtree_operation(
        &repository,
        SubtreeOperation::Pull {
            subtree_id: id.clone(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "SUBTREE_REGISTRATION_PENDING");

    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Remove {
            subtree_id: id.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::subtrees(&repository, &token).await.unwrap().is_empty());
    assert!(parent.path().join("vendor/library/library.txt").exists());
    let removed_section = Command::new("git")
        .args([
            "config",
            "--local",
            "--get-regexp",
            &format!("^versiondock\\.subtree\\.{id}\\."),
        ])
        .current_dir(parent.path())
        .output()
        .unwrap();
    assert!(!removed_section.status.success());
    assert!(vcs::subtree_operation(
        &repository,
        SubtreeOperation::Add {
            prefix: "../escape".into(),
            remote: "subtree-source".into(),
            branch: "main".into(),
            squash: false,
        },
        &token,
    )
    .await
    .is_err());
    assert!(vcs::subtree_operation(
        &repository,
        SubtreeOperation::Add {
            prefix: "vendor/url".into(),
            remote: bare_remote.path().to_string_lossy().into_owned(),
            branch: "main".into(),
            squash: false,
        },
        &token,
    )
    .await
    .is_err());
    let svn_repository = repo(parent.path(), VcsKind::Svn);
    let error = vcs::subtrees(&svn_repository, &token).await.unwrap_err();
    assert_eq!(error.code, "UNSUPPORTED_OPERATION");
}

#[tokio::test]
async fn real_git_core_workflow() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let directory = tempdir().unwrap();
    let remote = tempdir().unwrap();
    command("git", &["init", "--bare"], remote.path());
    command("git", &["init", "-b", "main"], directory.path());
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        directory.path(),
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.test"],
        directory.path(),
    );
    std::fs::write(directory.path().join("hello world 中文.txt"), "one\n").unwrap();
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    let status = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status.files[0].status, "untracked");
    let diff = vcs::diff(&repository, "hello world 中文.txt", false, None, &token)
        .await
        .unwrap();
    assert!(!diff.binary);
    vcs::stage(&repository, &["hello world 中文.txt".into()], &token)
        .await
        .unwrap();
    vcs::commit(&repository, "initial commit", false, &[], &token)
        .await
        .unwrap();
    command(
        "git",
        &["remote", "add", "origin", remote.path().to_str().unwrap()],
        directory.path(),
    );
    command(
        "git",
        &["push", "--set-upstream", "origin", "main"],
        directory.path(),
    );
    std::fs::write(directory.path().join("hello world 中文.txt"), "one\ntwo\n").unwrap();
    let diff = vcs::diff(&repository, "hello world 中文.txt", false, None, &token)
        .await
        .unwrap();
    assert!(diff.content.contains("+two"));
    vcs::stage(&repository, &["hello world 中文.txt".into()], &token)
        .await
        .unwrap();
    vcs::unstage(&repository, &["hello world 中文.txt".into()], &token)
        .await
        .unwrap();
    vcs::stage(&repository, &["hello world 中文.txt".into()], &token)
        .await
        .unwrap();
    vcs::commit(&repository, "second commit", false, &[], &token)
        .await
        .unwrap();
    let history = vcs::history(&repository, 0, 20, None, &token)
        .await
        .unwrap();
    assert_eq!(history.commits.len(), 2);
    vcs::branch_operation(
        &repository,
        BranchOperation::Create {
            name: "feature/test".into(),
            from: None,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::branches(&repository, &token)
        .await
        .unwrap()
        .iter()
        .any(|branch| branch.current && branch.name == "feature/test"));
    vcs::tag_operation(
        &repository,
        TagOperation::Create {
            name: "v0.1.0".into(),
            revision: None,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::tags(&repository, &token)
        .await
        .unwrap()
        .iter()
        .any(|tag| tag.name == "v0.1.0"));

    std::fs::write(
        directory.path().join("hello world 中文.txt"),
        "one\ntwo\nstashed\n",
    )
    .unwrap();
    std::fs::write(directory.path().join("stash untracked.txt"), "untracked\n").unwrap();
    vcs::stash_operation(
        &repository,
        StashOperation::Create {
            message: "integration stash".into(),
            paths: vec![],
            include_untracked: true,
        },
        &token,
    )
    .await
    .unwrap();
    let stashes = vcs::stashes(&repository, &token).await.unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].message, "integration stash");
    assert!(!directory.path().join("stash untracked.txt").exists());
    vcs::stash_operation(
        &repository,
        StashOperation::Apply {
            reference: stashes[0].reference.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(directory.path().join("stash untracked.txt").exists());
    command("git", &["reset", "--hard", "HEAD"], directory.path());
    std::fs::remove_file(directory.path().join("stash untracked.txt")).unwrap();
    vcs::stash_operation(
        &repository,
        StashOperation::Drop {
            reference: stashes[0].reference.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::stashes(&repository, &token).await.unwrap().is_empty());
    assert!(vcs::stash_operation(
        &repository,
        StashOperation::Drop {
            reference: "--all".into(),
        },
        &token,
    )
    .await
    .is_err());

    let shelf_storage = tempdir().unwrap();
    std::fs::write(
        directory.path().join("hello world 中文.txt"),
        "one\ntwo\nshelved\n",
    )
    .unwrap();
    std::fs::write(directory.path().join("shelf untracked.txt"), "shelf\n").unwrap();
    shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Create {
            name: "integration shelf".into(),
            paths: vec![],
        },
        &token,
    )
    .await
    .unwrap();
    assert!(workspace::git_status(repository.clone(), &token)
        .await
        .unwrap()
        .files
        .is_empty());
    assert!(vcs::stashes(&repository, &token).await.unwrap().is_empty());
    let shelves = shelf::list(shelf_storage.path(), &repository)
        .await
        .unwrap();
    assert_eq!(shelves.len(), 1);
    assert_eq!(shelves[0].name, "integration shelf");
    assert!(shelves[0].files.contains(&"shelf untracked.txt".into()));
    shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Apply {
            shelf_id: shelves[0].id.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(directory.path().join("shelf untracked.txt").exists());
    command("git", &["reset", "--hard", "HEAD"], directory.path());
    std::fs::remove_file(directory.path().join("shelf untracked.txt")).unwrap();
    shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Drop {
            shelf_id: shelves[0].id.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(shelf::list(shelf_storage.path(), &repository)
        .await
        .unwrap()
        .is_empty());
    assert!(shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Drop {
            shelf_id: "../../escape".into(),
        },
        &token,
    )
    .await
    .is_err());

    let worktree_storage = tempdir().unwrap();
    vcs::worktree_operation(
        worktree_storage.path(),
        &repository,
        crate::models::WorktreeOperation::Create {
            branch: "worktree/integration".into(),
            new_branch: true,
        },
        &token,
    )
    .await
    .unwrap();
    let linked = vcs::worktrees(&repository, &token)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.branch == "worktree/integration")
        .unwrap();
    vcs::worktree_operation(
        worktree_storage.path(),
        &repository,
        crate::models::WorktreeOperation::Lock {
            path: linked.path.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::worktrees(&repository, &token)
        .await
        .unwrap()
        .iter()
        .any(|entry| entry.branch == "worktree/integration" && entry.locked));
    vcs::worktree_operation(
        worktree_storage.path(),
        &repository,
        crate::models::WorktreeOperation::Unlock {
            path: linked.path.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    vcs::worktree_operation(
        worktree_storage.path(),
        &repository,
        crate::models::WorktreeOperation::Remove {
            path: linked.path,
            force: false,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(!vcs::worktrees(&repository, &token)
        .await
        .unwrap()
        .iter()
        .any(|entry| entry.branch == "worktree/integration"));

    vcs::sync(&repository, SyncAction::Push, None, &token)
        .await
        .unwrap();
    vcs::sync(&repository, SyncAction::Fetch, None, &token)
        .await
        .unwrap();
    vcs::sync(&repository, SyncAction::Pull, None, &token)
        .await
        .unwrap();

    command("git", &["switch", "main"], directory.path());
    command("git", &["switch", "-c", "conflict-side"], directory.path());
    std::fs::write(directory.path().join("conflict.txt"), "side\n").unwrap();
    command("git", &["add", "conflict.txt"], directory.path());
    command("git", &["commit", "-m", "side conflict"], directory.path());
    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("conflict.txt"), "main\n").unwrap();
    command("git", &["add", "conflict.txt"], directory.path());
    command("git", &["commit", "-m", "main conflict"], directory.path());
    let merge = Command::new("git")
        .args(["merge", "conflict-side"])
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(!merge.status.success());
    let conflicted = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(conflicted
        .files
        .iter()
        .any(|file| file.path == "conflict.txt" && file.conflicted));
    let versions = vcs::conflict_versions(&repository, "conflict.txt", &token)
        .await
        .unwrap();
    assert_eq!(versions.ours, "main\n");
    assert_eq!(versions.theirs, "side\n");
    let marker_error = vcs::conflict_save(
        &repository,
        "conflict.txt",
        "<<<<<<< ours\n=======\n>>>>>>> theirs\n",
        &versions.fingerprint,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(marker_error.code, "UNRESOLVED_MARKERS");
    vcs::conflict_save(
        &repository,
        "conflict.txt",
        "resolved\n",
        &versions.fingerprint,
        &token,
    )
    .await
    .unwrap();
    let resolved = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(!resolved.files.iter().any(|file| file.conflicted));
    assert!(resolved
        .files
        .iter()
        .any(|file| file.path == "conflict.txt" && file.staged));
    command("git", &["merge", "--abort"], directory.path());

    command("git", &["switch", "conflict-side"], directory.path());
    std::fs::write(directory.path().join("binary.bin"), [0_u8, 1, 2]).unwrap();
    command("git", &["add", "binary.bin"], directory.path());
    command("git", &["commit", "-m", "side binary"], directory.path());
    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("binary.bin"), [0_u8, 3, 4]).unwrap();
    command("git", &["add", "binary.bin"], directory.path());
    command("git", &["commit", "-m", "main binary"], directory.path());
    let merge = Command::new("git")
        .args(["merge", "conflict-side"])
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(!merge.status.success());
    assert!(
        vcs::conflict_versions(&repository, "binary.bin", &token)
            .await
            .unwrap()
            .binary
    );
    vcs::conflict_accept(&repository, "binary.bin", ConflictChoice::Theirs, &token)
        .await
        .unwrap();
    let binary_status = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(!binary_status
        .files
        .iter()
        .any(|file| file.path == "binary.bin" && file.conflicted));
}

#[tokio::test]
async fn real_svn_core_workflow() {
    if !available("svn") || !available("svnadmin") {
        eprintln!("SKIP: svn or svnadmin not available");
        return;
    }
    let directory = tempdir().unwrap();
    let repository_path = directory.path().join("repository");
    let checkout = directory.path().join("checkout");
    command(
        "svnadmin",
        &["create", repository_path.to_str().unwrap()],
        directory.path(),
    );
    let url = format!("file://{}", repository_path.display());
    command(
        "svn",
        &["checkout", &url, checkout.to_str().unwrap()],
        directory.path(),
    );
    std::fs::write(checkout.join("中文 file.txt"), "one\n").unwrap();
    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();

    let status = workspace::svn_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status.files[0].status, "unversioned");
    vcs::commit(
        &repository,
        "initial svn commit",
        false,
        &["中文 file.txt".into()],
        &token,
    )
    .await
    .unwrap();
    std::fs::write(checkout.join("中文 file.txt"), "one\ntwo\n").unwrap();
    let diff = vcs::diff(&repository, "中文 file.txt", false, None, &token)
        .await
        .unwrap();
    assert!(diff.content.contains("+two"));
    vcs::commit(
        &repository,
        "second svn commit",
        false,
        &["中文 file.txt".into()],
        &token,
    )
    .await
    .unwrap();
    let history = vcs::history(&repository, 0, 20, None, &token)
        .await
        .unwrap();
    assert!(
        history.commits.len() >= 2,
        "SVN history: {:#?}",
        history.commits
    );
}
