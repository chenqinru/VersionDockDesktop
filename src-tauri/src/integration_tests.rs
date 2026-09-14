use std::{path::Path, process::Command};

use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

use crate::{
    models::{
        BranchOperation, BranchRecoveryOperation, BranchRecoveryStatus, CommitPathOperationEntry,
        ConflictChoice, HistoryOperation, HistoryQuery, RemoteOperation, RepositoryMeta,
        StashOperation, SubmoduleOperation, SubtreeOperation, SubtreeState, SvnOperation,
        SyncAction, TagOperation, UnpushedOperation, VcsKind,
    },
    shelf, vcs, workspace,
};

fn available(program: &str) -> bool {
    let resolved = crate::cli::resolve_executable(program);
    let available = Command::new(&resolved)
        .arg("--version")
        .output()
        .map(|value| value.status.success())
        .unwrap_or(false);
    assert!(
        available || std::env::var("VERSIONDOCK_REQUIRE_VCS_TESTS").as_deref() != Ok("1"),
        "required integration-test tool is unavailable: {program}"
    );
    available
}

#[tokio::test]
async fn v5_init_clone_commit_messages_and_structured_history_are_real() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let source = root.path().join("源 仓库");
    std::fs::create_dir(&source).unwrap();
    let token = CancellationToken::new();
    vcs::initialize_repository(&source, &token).await.unwrap();
    command("git", &["config", "user.name", "Ada Lovelace"], &source);
    command(
        "git",
        &["config", "user.email", "ada@example.test"],
        &source,
    );
    std::fs::write(source.join("中文 file.txt"), "needle body\n").unwrap();
    command("git", &["add", "."], &source);
    command(
        "git",
        &["commit", "-m", "subject line", "-m", "searchable body"],
        &source,
    );
    let source_repo = repo(&source, VcsKind::Git);
    let messages = vcs::recent_commit_messages(&source_repo, &token)
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].message.contains("searchable body"));
    assert_eq!(
        vcs::last_commit_message(&source_repo, &token)
            .await
            .unwrap(),
        Some(messages[0].message.clone())
    );
    let page = vcs::history(
        &source_repo,
        0,
        10,
        HistoryQuery {
            text: Some("searchable body".into()),
            author: Some("Ada".into()),
            path: Some("中文 file.txt".into()),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(page.commits.len(), 1);

    let clones = root.path().join("clones");
    std::fs::create_dir(&clones).unwrap();
    let cloned = vcs::clone_repository(
        source.to_str().unwrap(),
        &clones,
        "副本",
        None,
        false,
        &token,
    )
    .await
    .unwrap();
    assert!(cloned.join(".git").is_dir());
    assert!(
        vcs::clone_repository("--upload-pack=evil", &clones, "bad", None, false, &token)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn real_git_branch_recovery_stashes_and_carries_changes() {
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    command("git", &["init", "-b", "main"], directory.path());
    command("git", &["config", "user.name", "Ada"], directory.path());
    command(
        "git",
        &["config", "user.email", "ada@example.test"],
        directory.path(),
    );
    std::fs::write(directory.path().join("file.txt"), "base\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    command("git", &["branch", "feature"], directory.path());
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    std::fs::write(directory.path().join("file.txt"), "stash me\n").unwrap();
    std::fs::write(directory.path().join("untracked.txt"), "secret\n").unwrap();
    let stashed = vcs::branch_recovery(
        &repository,
        BranchRecoveryOperation::StashAndCheckout {
            target: "feature".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(stashed.status, BranchRecoveryStatus::Completed);
    assert_eq!(stashed.stash_reference.as_deref(), Some("stash@{0}"));
    assert!(!directory.path().join("untracked.txt").exists());

    std::fs::write(directory.path().join("file.txt"), "carry me\n").unwrap();
    let carried = vcs::branch_recovery(
        &repository,
        BranchRecoveryOperation::CarryChanges {
            target: "main".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(carried.status, BranchRecoveryStatus::Completed);
    assert!(carried.changes_restored);
    assert_eq!(
        std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
        "carry me\n"
    );

    std::fs::write(directory.path().join("keep-untracked.txt"), "keep\n").unwrap();
    let forced = vcs::branch_recovery(
        &repository,
        BranchRecoveryOperation::ForceCheckout {
            target: "feature".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(forced.status, BranchRecoveryStatus::Completed);
    assert_eq!(
        std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
        "base\n"
    );
    assert!(directory.path().join("keep-untracked.txt").exists());
    std::fs::remove_file(directory.path().join("keep-untracked.txt")).unwrap();

    command("git", &["switch", "-c", "merge-target"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "target\n").unwrap();
    command("git", &["commit", "-am", "target"], directory.path());
    command("git", &["switch", "feature"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "dirty before merge\n").unwrap();
    let merged = vcs::branch_recovery(
        &repository,
        BranchRecoveryOperation::StashAndMerge {
            target: "merge-target".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(merged.status, BranchRecoveryStatus::Completed);
    assert_eq!(merged.stash_reference.as_deref(), Some("stash@{0}"));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
        "target\n"
    );
}

#[tokio::test]
async fn real_git_restore_conflicts_rejects_an_active_merge() {
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    command("git", &["init", "-b", "main"], directory.path());
    command("git", &["config", "user.name", "Ada"], directory.path());
    command(
        "git",
        &["config", "user.email", "ada@example.test"],
        directory.path(),
    );
    std::fs::write(directory.path().join("file.txt"), "base\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    command("git", &["switch", "-c", "feature"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "feature\n").unwrap();
    command("git", &["commit", "-am", "feature"], directory.path());
    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "main\n").unwrap();
    command("git", &["commit", "-am", "main"], directory.path());
    let status = Command::new(crate::cli::resolve_executable("git"))
        .args(["merge", "feature"])
        .current_dir(directory.path())
        .status()
        .unwrap();
    assert!(!status.success());
    let error = vcs::restore_conflicts(
        &repo(directory.path(), VcsKind::Git),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "OPERATION_IN_PROGRESS");
    std::fs::remove_file(directory.path().join(".git/MERGE_HEAD")).unwrap();
    let restored = vcs::restore_conflicts(
        &repo(directory.path(), VcsKind::Git),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(restored.restored_paths, ["file.txt"]);
    assert!(restored.failures.is_empty());
    assert_eq!(
        std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
        "main\n"
    );
}

fn svn_file_url(path: &Path) -> String {
    url::Url::from_file_path(path)
        .expect("SVN repository path must be absolute")
        .into()
}

#[test]
fn svn_file_urls_are_canonical_and_percent_encoded() {
    let directory = tempdir().unwrap();
    let repository_path = directory.path().join("repository path");
    std::fs::create_dir(&repository_path).unwrap();

    let value = svn_file_url(&repository_path);

    assert!(value.starts_with("file:///"));
    assert!(value.contains("repository%20path"));
    assert!(!value.contains('\\'));
    assert_eq!(
        url::Url::parse(&value).unwrap().to_file_path().unwrap(),
        repository_path
    );
}

#[tokio::test]
async fn real_git_file_history_follows_rename_and_loads_revision_content() {
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
    std::fs::write(directory.path().join("旧 文件.txt"), "first\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "initial file"], directory.path());
    command(
        "git",
        &["mv", "旧 文件.txt", "new file.txt"],
        directory.path(),
    );
    std::fs::write(directory.path().join("new file.txt"), "first\nsecond\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "rename file"], directory.path());
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let history = vcs::file_history(&repository, "new file.txt", None, 20, &token)
        .await
        .unwrap();
    assert_eq!(history.entries.len(), 2);
    assert!(history
        .entries
        .iter()
        .any(|entry| entry.message == "initial file"));
    let newest = &history.entries[0];
    let content = vcs::file_revision_content(
        &repository,
        &newest.path,
        &newest.revision,
        crate::models::CatFileFilterMode::Filters,
        &token,
    )
    .await
    .unwrap();
    assert!(content.content.contains("second"));
    assert!(!content.binary);
    let oldest = history
        .entries
        .iter()
        .find(|entry| entry.message == "initial file")
        .unwrap();
    assert_eq!(oldest.path, "旧 文件.txt");
    let old_content = vcs::file_revision_content(
        &repository,
        &oldest.path,
        &oldest.revision,
        crate::models::CatFileFilterMode::Filters,
        &token,
    )
    .await
    .unwrap();
    assert!(old_content.content.contains("first"));
}

#[tokio::test]
async fn real_git_file_history_follows_copy_source_and_loads_oldest_content() {
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
    std::fs::write(directory.path().join("source.java"), "class Source {}\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "initial source"], directory.path());
    std::fs::copy(
        directory.path().join("source.java"),
        directory.path().join("copied.java"),
    )
    .unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "copy source"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let history = vcs::file_history(&repository, "copied.java", None, 20, &token)
        .await
        .unwrap();
    assert_eq!(history.entries.len(), 2);
    assert_eq!(history.entries[0].path, "copied.java");
    assert_eq!(
        history.entries[0].previous_path.as_deref(),
        Some("source.java")
    );
    assert_eq!(history.entries[1].path, "source.java");
    let old_content = vcs::file_revision_content(
        &repository,
        &history.entries[1].path,
        &history.entries[1].revision,
        crate::models::CatFileFilterMode::Filters,
        &token,
    )
    .await
    .unwrap();
    assert!(old_content.content.contains("class Source"));
}

#[tokio::test]
async fn real_git_and_svn_untracked_files_produce_visible_diffs() {
    let token = CancellationToken::new();
    if available("git") {
        let directory = tempdir().unwrap();
        command("git", &["init", "-b", "main"], directory.path());
        std::fs::write(
            directory.path().join("new 中文 file.txt"),
            "first\nsecond\n",
        )
        .unwrap();
        let repository = repo(directory.path(), VcsKind::Git);
        let diff = vcs::diff(
            &repository,
            "new 中文 file.txt",
            false,
            None,
            None,
            None,
            &token,
        )
        .await
        .unwrap();
        assert!(diff.content.contains("new file mode"));
        assert!(diff.content.contains("+second"));
        assert_eq!(diff.language, "text");
        let rules = vcs::add_ignore(&repository, "new 中文 file.txt", &token)
            .await
            .unwrap();
        assert!(rules.patterns.contains(&"/new 中文 file.txt".to_string()));
        vcs::update_ignore_rules(&repository, "", &["/custom/".into()], &token)
            .await
            .unwrap();
        assert_eq!(read_text(directory.path().join(".gitignore")), "/custom/\n");
    }
    if available("svn") && available("svnadmin") {
        let repository_dir = tempdir().unwrap();
        let checkout_parent = tempdir().unwrap();
        command(
            "svnadmin",
            &["create", repository_dir.path().to_str().unwrap()],
            checkout_parent.path(),
        );
        let checkout = checkout_parent.path().join("wc");
        command(
            "svn",
            &[
                "checkout",
                &svn_file_url(repository_dir.path()),
                checkout.to_str().unwrap(),
            ],
            checkout_parent.path(),
        );
        std::fs::write(checkout.join("new svn.txt"), "svn line\n").unwrap();
        let repository = repo(&checkout, VcsKind::Svn);
        let diff = vcs::diff(&repository, "new svn.txt", false, None, None, None, &token)
            .await
            .unwrap();
        assert!(diff.content.contains("+svn line"));
        let rules = vcs::add_ignore(&repository, "new svn.txt", &token)
            .await
            .unwrap();
        assert!(rules.patterns.contains(&"new svn.txt".to_string()));
    }
}

#[tokio::test]
async fn real_svn_file_history_loads_revisions_and_content() {
    if !available("svn") || !available("svnadmin") {
        eprintln!("SKIP: svn or svnadmin not available");
        return;
    }
    let repository_dir = tempdir().unwrap();
    let checkout_parent = tempdir().unwrap();
    command(
        "svnadmin",
        &["create", repository_dir.path().to_str().unwrap()],
        checkout_parent.path(),
    );
    let url = svn_file_url(repository_dir.path());
    let checkout = checkout_parent.path().join("工作 副本");
    command(
        "svn",
        &["checkout", &url, checkout.to_str().unwrap()],
        checkout_parent.path(),
    );
    std::fs::write(checkout.join("历史 文件.txt"), "first\n").unwrap();
    command("svn", &["add", "历史 文件.txt"], &checkout);
    command("svn", &["commit", "-m", "first revision"], &checkout);
    std::fs::write(checkout.join("历史 文件.txt"), "first\nsecond\n").unwrap();
    command("svn", &["commit", "-m", "second revision"], &checkout);
    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();
    let history = vcs::file_history(&repository, "历史 文件.txt", None, 20, &token)
        .await
        .unwrap();
    assert!(history.entries.len() >= 2);
    let newest = &history.entries[0];
    let content = vcs::file_revision_content(
        &repository,
        "历史 文件.txt",
        &newest.revision,
        crate::models::CatFileFilterMode::Filters,
        &token,
    )
    .await
    .unwrap();
    assert!(content.content.contains("second"));
}

#[tokio::test]
async fn real_svn_commit_keeps_unselected_children_out_of_revision() {
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let repository_dir = tempdir().unwrap();
    let checkout_parent = tempdir().unwrap();
    command(
        "svnadmin",
        &["create", repository_dir.path().to_str().unwrap()],
        checkout_parent.path(),
    );
    let checkout = checkout_parent.path().join("working");
    command(
        "svn",
        &[
            "checkout",
            &svn_file_url(repository_dir.path()),
            checkout.to_str().unwrap(),
        ],
        checkout_parent.path(),
    );
    let directory = checkout.join("new");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("selected.txt"), "selected\n").unwrap();
    std::fs::write(directory.join("other.txt"), "other\n").unwrap();
    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();
    vcs::commit(
        &repository,
        "selected only",
        false,
        &["new/selected.txt".into()],
        &token,
    )
    .await
    .unwrap();
    let changed = command_output("svn", &["log", "-v", "-r", "HEAD"], &checkout);
    assert!(changed.contains("/new/selected.txt"));
    assert!(!changed.contains("/new/other.txt"));
    assert!(command_output("svn", &["status"], &checkout).contains("?       new/other.txt"));

    std::fs::write(directory.join("selected.txt"), "changed\n").unwrap();
    command(
        "svn",
        &["propset", "test:mark", "directory", "new"],
        &checkout,
    );
    vcs::commit(
        &repository,
        "directory only",
        false,
        &["new".into()],
        &token,
    )
    .await
    .unwrap();
    assert!(command_output("svn", &["status"], &checkout).contains("M       new/selected.txt"));

    let overflow = checkout.join("overflow");
    std::fs::create_dir(&overflow).unwrap();
    for index in 0..501 {
        std::fs::write(overflow.join(format!("{index:03}.txt")), "file\n").unwrap();
    }
    std::fs::create_dir(overflow.join(".git")).unwrap();
    std::fs::write(overflow.join(".git/config"), "secret\n").unwrap();
    let status = workspace::svn_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(status
        .files
        .iter()
        .any(|file| file.path == "overflow" && file.is_truncated));
    assert!(!status.files.iter().any(|file| file.path.contains(".git")));
    let error = vcs::stage(&repository, &["overflow".into()], true, &token)
        .await
        .unwrap_err();
    assert_eq!(error.code, "SVN_NESTED_VCS_METADATA");
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
        read_text(directory.path().join("tracked.txt")),
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

fn read_text(path: impl AsRef<Path>) -> String {
    std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

fn command(program: &str, args: &[&str], cwd: &Path) {
    let resolved = crate::cli::resolve_executable(program);
    let output = Command::new(&resolved)
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

fn command_output(program: &str, args: &[&str], cwd: &Path) -> String {
    let resolved = crate::cli::resolve_executable(program);
    let output = Command::new(&resolved)
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
    String::from_utf8(output.stdout).unwrap().trim().to_string()
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
async fn real_git_pull_auto_stash_preserves_staged_and_unstaged_changes() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let seed = root.path().join("seed");
    let working = root.path().join("working");
    let upstream = root.path().join("upstream");
    command(
        "git",
        &["init", "--bare", remote.to_str().unwrap()],
        root.path(),
    );
    command(
        "git",
        &["init", "-b", "main", seed.to_str().unwrap()],
        root.path(),
    );
    command("git", &["config", "user.name", "VersionDock Test"], &seed);
    command("git", &["config", "user.email", "test@example.test"], &seed);
    std::fs::write(seed.join("local.txt"), "base\n").unwrap();
    std::fs::write(seed.join("remote.txt"), "base\n").unwrap();
    command("git", &["add", "."], &seed);
    command("git", &["commit", "-m", "base"], &seed);
    command(
        "git",
        &["remote", "add", "origin", remote.to_str().unwrap()],
        &seed,
    );
    command("git", &["push", "-u", "origin", "main"], &seed);
    command("git", &["symbolic-ref", "HEAD", "refs/heads/main"], &remote);
    command(
        "git",
        &["clone", remote.to_str().unwrap(), working.to_str().unwrap()],
        root.path(),
    );
    command(
        "git",
        &[
            "clone",
            remote.to_str().unwrap(),
            upstream.to_str().unwrap(),
        ],
        root.path(),
    );
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        &upstream,
    );
    command(
        "git",
        &["config", "user.email", "test@example.test"],
        &upstream,
    );
    std::fs::write(upstream.join("remote.txt"), "upstream\n").unwrap();
    command("git", &["add", "remote.txt"], &upstream);
    command("git", &["commit", "-m", "upstream"], &upstream);
    command("git", &["push"], &upstream);

    std::fs::write(working.join("local.txt"), "staged\n").unwrap();
    command("git", &["add", "local.txt"], &working);
    std::fs::write(working.join("local.txt"), "unstaged\n").unwrap();
    std::fs::write(working.join("untracked.txt"), "untracked\n").unwrap();

    vcs::sync(
        &repo(&working, VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &crate::models::DesktopSettings::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(read_text(working.join("remote.txt")), "upstream\n");
    assert_eq!(read_text(working.join("local.txt")), "unstaged\n");
    assert!(
        command_output("git", &["diff", "--cached", "--", "local.txt"], &working)
            .contains("+staged")
    );
    assert!(command_output("git", &["diff", "--", "local.txt"], &working).contains("+unstaged"));
    assert!(working.join("untracked.txt").is_file());
    assert!(command_output("git", &["stash", "list"], &working).is_empty());
}

#[tokio::test]
async fn real_git_pull_auto_stash_keeps_backup_when_restore_conflicts() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let seed = root.path().join("seed");
    let working = root.path().join("working");
    let upstream = root.path().join("upstream");
    command(
        "git",
        &["init", "--bare", remote.to_str().unwrap()],
        root.path(),
    );
    command(
        "git",
        &["init", "-b", "main", seed.to_str().unwrap()],
        root.path(),
    );
    command("git", &["config", "user.name", "VersionDock Test"], &seed);
    command("git", &["config", "user.email", "test@example.test"], &seed);
    std::fs::write(seed.join("shared.txt"), "base\n").unwrap();
    command("git", &["add", "."], &seed);
    command("git", &["commit", "-m", "base"], &seed);
    command(
        "git",
        &["remote", "add", "origin", remote.to_str().unwrap()],
        &seed,
    );
    command("git", &["push", "-u", "origin", "main"], &seed);
    command("git", &["symbolic-ref", "HEAD", "refs/heads/main"], &remote);
    command(
        "git",
        &["clone", remote.to_str().unwrap(), working.to_str().unwrap()],
        root.path(),
    );
    command(
        "git",
        &[
            "clone",
            remote.to_str().unwrap(),
            upstream.to_str().unwrap(),
        ],
        root.path(),
    );
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        &upstream,
    );
    command(
        "git",
        &["config", "user.email", "test@example.test"],
        &upstream,
    );
    std::fs::write(upstream.join("shared.txt"), "upstream\n").unwrap();
    command("git", &["add", "shared.txt"], &upstream);
    command("git", &["commit", "-m", "upstream"], &upstream);
    command("git", &["push"], &upstream);
    std::fs::write(working.join("shared.txt"), "local\n").unwrap();

    let error = vcs::sync(
        &repo(&working, VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &crate::models::DesktopSettings::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "GIT_AUTO_STASH_CONFLICT");
    assert!(!command_output("git", &["stash", "list"], &working).is_empty());
    assert!(
        !command_output("git", &["diff", "--name-only", "--diff-filter=U"], &working).is_empty()
    );
}

#[tokio::test]
async fn real_git_pull_targets_non_current_and_remote_branches() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let parent = tempdir().unwrap();
    let remote = parent.path().join("remote.git");
    let seed = parent.path().join("seed");
    let working = parent.path().join("working");
    let upstream = parent.path().join("upstream");
    command(
        "git",
        &["init", "--bare", remote.to_str().unwrap()],
        parent.path(),
    );
    command(
        "git",
        &["init", "-b", "main", seed.to_str().unwrap()],
        parent.path(),
    );
    command("git", &["config", "user.name", "VersionDock Test"], &seed);
    command(
        "git",
        &["config", "user.email", "versiondock@example.com"],
        &seed,
    );
    std::fs::write(seed.join("base.txt"), "base\n").unwrap();
    command("git", &["add", "."], &seed);
    command("git", &["commit", "-m", "base"], &seed);
    command(
        "git",
        &["remote", "add", "origin", remote.to_str().unwrap()],
        &seed,
    );
    command("git", &["push", "-u", "origin", "main"], &seed);
    command("git", &["symbolic-ref", "HEAD", "refs/heads/main"], &remote);
    command("git", &["switch", "-c", "feature"], &seed);
    std::fs::write(seed.join("feature.txt"), "feature one\n").unwrap();
    command("git", &["add", "."], &seed);
    command("git", &["commit", "-m", "feature one"], &seed);
    command("git", &["push", "-u", "origin", "feature"], &seed);
    command(
        "git",
        &["clone", remote.to_str().unwrap(), working.to_str().unwrap()],
        parent.path(),
    );
    command(
        "git",
        &["-C", working.to_str().unwrap(), "switch", "main"],
        parent.path(),
    );
    command(
        "git",
        &[
            "-C",
            working.to_str().unwrap(),
            "branch",
            "--track",
            "feature",
            "origin/feature",
        ],
        parent.path(),
    );
    command(
        "git",
        &[
            "clone",
            remote.to_str().unwrap(),
            upstream.to_str().unwrap(),
        ],
        parent.path(),
    );
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        &upstream,
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.com"],
        &upstream,
    );
    command("git", &["switch", "feature"], &upstream);
    std::fs::write(upstream.join("feature.txt"), "feature two\n").unwrap();
    command("git", &["add", "."], &upstream);
    command("git", &["commit", "-m", "feature two"], &upstream);
    command("git", &["push"], &upstream);

    let repository = repo(&working, VcsKind::Git);
    let token = CancellationToken::new();
    vcs::sync(
        &repository,
        SyncAction::Pull,
        None,
        Some("feature".into()),
        false,
        &crate::models::DesktopSettings::default(),
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output("git", &["branch", "--show-current"], &working),
        "main"
    );
    assert_eq!(
        command_output("git", &["rev-parse", "feature"], &working),
        command_output("git", &["rev-parse", "origin/feature"], &working)
    );

    command("git", &["switch", "main"], &upstream);
    std::fs::write(upstream.join("remote-main.txt"), "remote\n").unwrap();
    command("git", &["add", "."], &upstream);
    command("git", &["commit", "-m", "remote main"], &upstream);
    command("git", &["push"], &upstream);
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        &working,
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.com"],
        &working,
    );
    std::fs::write(working.join("local-main.txt"), "local\n").unwrap();
    command("git", &["add", "."], &working);
    command("git", &["commit", "-m", "local main"], &working);
    vcs::sync(
        &repository,
        SyncAction::PullRebase,
        Some("origin".into()),
        Some("origin/main".into()),
        false,
        &crate::models::DesktopSettings::default(),
        &token,
    )
    .await
    .unwrap();
    assert_eq!(read_text(working.join("remote-main.txt")), "remote\n");
    assert_eq!(read_text(working.join("local-main.txt")), "local\n");
    assert_eq!(
        command_output(
            "git",
            &["rev-list", "--count", "origin/main..HEAD"],
            &working
        ),
        "1"
    );
}

#[tokio::test]
async fn real_git_unpushed_history_operations_are_effective_and_safe() {
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
    std::fs::write(directory.path().join("base.txt"), "base\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    std::fs::write(directory.path().join("one.txt"), "one\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "one"], directory.path());
    let one = command_output("git", &["rev-parse", "HEAD"], directory.path());
    vcs::unpushed_operation(
        &repository,
        UnpushedOperation::EditMessage {
            hash: one,
            message: "one edited".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output("git", &["log", "-1", "--format=%s"], directory.path()),
        "one edited"
    );

    vcs::unpushed_operation(&repository, UnpushedOperation::UndoHead, &token)
        .await
        .unwrap();
    assert!(
        !directory.path().join("one.txt").exists() || {
            command_output(
                "git",
                &["diff", "--cached", "--name-only"],
                directory.path(),
            ) == "one.txt"
        }
    );
    command("git", &["commit", "-m", "one restored"], directory.path());

    std::fs::write(directory.path().join("two.txt"), "two\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "two"], directory.path());
    let two = command_output("git", &["rev-parse", "HEAD"], directory.path());
    std::fs::write(directory.path().join("three.txt"), "three\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "three"], directory.path());
    let three = command_output("git", &["rev-parse", "HEAD"], directory.path());
    vcs::unpushed_operation(
        &repository,
        UnpushedOperation::Squash {
            hashes: vec![three, two],
            message: "two and three".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output("git", &["log", "-1", "--format=%s"], directory.path()),
        "two and three"
    );
    assert!(directory.path().join("two.txt").exists());
    assert!(directory.path().join("three.txt").exists());

    std::fs::write(directory.path().join("drop.txt"), "drop\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "drop me"], directory.path());
    let drop_hash = command_output("git", &["rev-parse", "HEAD"], directory.path());
    std::fs::write(directory.path().join("keep.txt"), "keep\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "keep me"], directory.path());
    vcs::unpushed_operation(
        &repository,
        UnpushedOperation::Drop {
            hashes: vec![drop_hash],
        },
        &token,
    )
    .await
    .unwrap();
    assert!(!directory.path().join("drop.txt").exists());
    assert!(directory.path().join("keep.txt").exists());

    let head = command_output("git", &["rev-parse", "HEAD"], directory.path());
    vcs::unpushed_operation(
        &repository,
        UnpushedOperation::Revert { hashes: vec![head] },
        &token,
    )
    .await
    .unwrap();
    assert!(!directory.path().join("keep.txt").exists());
    assert!(
        command_output("git", &["log", "-1", "--format=%s"], directory.path())
            .starts_with("Revert")
    );

    std::fs::write(directory.path().join("dirty.txt"), "dirty\n").unwrap();
    let head = command_output("git", &["rev-parse", "HEAD"], directory.path());
    let error = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::EditMessage {
            hash: head,
            message: "must fail".into(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "WORKTREE_NOT_CLEAN");
}

#[tokio::test]
async fn real_git_history_context_operations_modify_the_expected_targets() {
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
    std::fs::write(directory.path().join("value.txt"), "base\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    let base = command_output("git", &["rev-parse", "HEAD"], directory.path());
    std::fs::write(directory.path().join("value.txt"), "second\n").unwrap();
    command("git", &["commit", "-am", "second"], directory.path());
    let second = command_output("git", &["rev-parse", "HEAD"], directory.path());
    command("git", &["switch", "-c", "side", &base], directory.path());
    std::fs::write(directory.path().join("side.txt"), "side\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "side"], directory.path());
    let side = command_output("git", &["rev-parse", "HEAD"], directory.path());
    command("git", &["switch", "main"], directory.path());
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let patch = vcs::create_patch(&repository, std::slice::from_ref(&second), &token)
        .await
        .unwrap();
    assert!(patch.content.contains("Subject: [PATCH] second"));
    assert!(patch.content.contains("diff --git"));
    assert!(patch.file_name.ends_with(".patch"));

    vcs::history_operation(
        &repository,
        HistoryOperation::CherryPick { revision: side },
        false,
        &token,
    )
    .await
    .unwrap();
    let picked = command_output("git", &["rev-parse", "HEAD"], directory.path());
    assert!(directory.path().join("side.txt").exists());
    vcs::history_operation(
        &repository,
        HistoryOperation::Revert {
            revisions: vec![picked],
        },
        false,
        &token,
    )
    .await
    .unwrap();
    assert!(!directory.path().join("side.txt").exists());

    std::fs::write(directory.path().join("value.txt"), "working\n").unwrap();
    vcs::history_operation(
        &repository,
        HistoryOperation::CheckoutFile {
            revision: second.clone(),
            path: "value.txt".into(),
        },
        false,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(read_text(directory.path().join("value.txt")), "second\n");
    command("git", &["reset", "--hard", "HEAD"], directory.path());

    std::fs::write(directory.path().join("reset.txt"), "reset\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "reset target"], directory.path());
    let before_reset = command_output("git", &["rev-parse", "HEAD^"], directory.path());
    vcs::history_operation(
        &repository,
        HistoryOperation::Reset {
            revision: before_reset.clone(),
            mode: "mixed".into(),
        },
        false,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output("git", &["rev-parse", "HEAD"], directory.path()),
        before_reset
    );
    assert!(directory.path().join("reset.txt").exists());
    command("git", &["reset", "--hard", "HEAD"], directory.path());
    std::fs::remove_file(directory.path().join("reset.txt")).unwrap();

    vcs::history_operation(
        &repository,
        HistoryOperation::Checkout {
            revision: base.clone(),
        },
        false,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output("git", &["rev-parse", "HEAD"], directory.path()),
        base
    );
    assert_eq!(
        command_output("git", &["branch", "--show-current"], directory.path()),
        ""
    );
    let error = vcs::history_operation(
        &repository,
        HistoryOperation::Reset {
            revision: second,
            mode: "unsafe".into(),
        },
        false,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_RESET_MODE");
}

#[tokio::test]
async fn real_git_commit_path_batches_apply_and_revert_directory_scopes() {
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
    std::fs::create_dir_all(directory.path().join("scope")).unwrap();
    std::fs::write(
        directory.path().join("scope/modified.txt"),
        "base modified\n",
    )
    .unwrap();
    std::fs::write(directory.path().join("scope/deleted.txt"), "base deleted\n").unwrap();
    std::fs::write(directory.path().join("scope/renamed-old.txt"), "renamed\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());

    std::fs::write(
        directory.path().join("scope/modified.txt"),
        "commit modified\n",
    )
    .unwrap();
    std::fs::write(directory.path().join("scope/added.txt"), "commit added\n").unwrap();
    std::fs::remove_file(directory.path().join("scope/deleted.txt")).unwrap();
    command(
        "git",
        &["mv", "scope/renamed-old.txt", "scope/renamed-new.txt"],
        directory.path(),
    );
    command("git", &["add", "."], directory.path());
    command(
        "git",
        &["commit", "-m", "directory scope"],
        directory.path(),
    );
    let revision = command_output("git", &["rev-parse", "HEAD"], directory.path());
    let entries = vec![
        CommitPathOperationEntry {
            revision: revision.clone(),
            path: "scope/modified.txt".into(),
            status: "M".into(),
        },
        CommitPathOperationEntry {
            revision: revision.clone(),
            path: "scope/added.txt".into(),
            status: "A".into(),
        },
        CommitPathOperationEntry {
            revision: revision.clone(),
            path: "scope/deleted.txt".into(),
            status: "D".into(),
        },
        CommitPathOperationEntry {
            revision: revision.clone(),
            path: "scope/renamed-new.txt".into(),
            status: "R100".into(),
        },
    ];
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    vcs::history_operation(
        &repository,
        HistoryOperation::RevertPaths {
            entries: entries.clone(),
        },
        false,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        read_text(directory.path().join("scope/modified.txt")),
        "base modified\n"
    );
    assert!(!directory.path().join("scope/added.txt").exists());
    assert_eq!(
        read_text(directory.path().join("scope/deleted.txt")),
        "base deleted\n"
    );
    assert!(directory.path().join("scope/renamed-old.txt").exists());
    assert!(!directory.path().join("scope/renamed-new.txt").exists());

    std::fs::write(
        directory.path().join("scope/modified.txt"),
        "working modified\n",
    )
    .unwrap();
    std::fs::remove_file(directory.path().join("scope/deleted.txt")).unwrap();
    std::fs::write(
        directory.path().join("scope/deleted.txt"),
        "working deleted\n",
    )
    .unwrap();
    vcs::history_operation(
        &repository,
        HistoryOperation::ApplyPaths {
            entries: entries.clone(),
        },
        false,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        read_text(directory.path().join("scope/modified.txt")),
        "commit modified\n"
    );
    assert_eq!(
        read_text(directory.path().join("scope/added.txt")),
        "commit added\n"
    );
    assert!(!directory.path().join("scope/deleted.txt").exists());
    assert!(!directory.path().join("scope/renamed-old.txt").exists());
    assert!(directory.path().join("scope/renamed-new.txt").exists());

    std::fs::write(directory.path().join("scope/modified.txt"), "must stay\n").unwrap();
    let error = vcs::history_operation(
        &repository,
        HistoryOperation::ApplyPaths {
            entries: vec![CommitPathOperationEntry {
                revision,
                path: "scope/modified.txt".into(),
                status: "A".into(),
            }],
        },
        false,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_COMMIT_PATH_OPERATION");
    assert_eq!(
        read_text(directory.path().join("scope/modified.txt")),
        "must stay\n"
    );
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
        read_text(parent.path().join("vendor/library/library.txt")),
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
        read_text(parent.path().join("vendor/library/library.txt")),
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

    std::fs::create_dir_all(parent.path().join("manual/registered")).unwrap();
    std::fs::write(
        parent.path().join("manual/registered/value.txt"),
        "registered\n",
    )
    .unwrap();
    command("git", &["add", "."], parent.path());
    command("git", &["commit", "-m", "manual directory"], parent.path());
    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Register {
            prefix: "manual/registered".into(),
            remote: "subtree-source".into(),
            branch: "main".into(),
            squash: false,
        },
        &token,
    )
    .await
    .unwrap();
    let registered = vcs::subtrees(&repository, &token)
        .await
        .unwrap()
        .into_iter()
        .find(|entry| entry.prefix == "manual/registered")
        .unwrap();
    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Edit {
            subtree_id: registered.id.clone(),
            prefix: registered.prefix.clone(),
            remote: registered.remote.clone(),
            branch: "main".into(),
            squash: true,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(
        vcs::subtrees(&repository, &token)
            .await
            .unwrap()
            .into_iter()
            .find(|entry| entry.id == registered.id)
            .unwrap()
            .squash
    );
    vcs::subtree_operation(
        &repository,
        SubtreeOperation::DeleteRegistry {
            subtree_id: registered.id,
        },
        &token,
    )
    .await
    .unwrap();

    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Split {
            subtree_id: id.clone(),
            branch: Some("subtree/library-test".into()),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output(
            "git",
            &["branch", "--list", "subtree/library-test"],
            parent.path(),
        ),
        "subtree/library-test"
    );
    vcs::subtree_operation(
        &repository,
        SubtreeOperation::Merge {
            subtree_id: id.clone(),
            revision: "subtree/library-test".into(),
            squash: true,
            message: Some("merge split branch".into()),
        },
        &token,
    )
    .await
    .unwrap();

    vcs::subtree_operation(
        &repository,
        SubtreeOperation::RemoveFiles {
            subtree_id: id.clone(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(!parent.path().join("vendor/library").exists());
    assert!(
        command_output("git", &["diff", "--cached", "--name-only"], parent.path())
            .contains("vendor/library/library.txt")
    );
    command("git", &["reset", "--hard", "HEAD"], parent.path());

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
        SubtreeOperation::DeleteRegistry {
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
async fn real_svn_advanced_working_copy_operations() {
    if !available("svn") || !available("svnadmin") {
        eprintln!("SKIP: svn or svnadmin not available");
        return;
    }
    let repository_dir = tempdir().unwrap();
    let working_parent = tempdir().unwrap();
    command(
        "svnadmin",
        &["create", repository_dir.path().to_str().unwrap()],
        working_parent.path(),
    );
    let repository_url = svn_file_url(repository_dir.path());
    command(
        "svn",
        &[
            "mkdir",
            &format!("{repository_url}/trunk"),
            &format!("{repository_url}/branches"),
            &format!("{repository_url}/tags"),
            "-m",
            "layout",
        ],
        working_parent.path(),
    );
    let working_copy = working_parent.path().join("wc");
    command(
        "svn",
        &[
            "checkout",
            &format!("{repository_url}/trunk"),
            working_copy.to_str().unwrap(),
        ],
        working_parent.path(),
    );
    std::fs::write(working_copy.join("locked file.txt"), "content\n").unwrap();
    command("svn", &["add", "locked file.txt"], &working_copy);
    command("svn", &["commit", "-m", "add lock target"], &working_copy);
    let repository = repo(&working_copy, VcsKind::Svn);
    let token = CancellationToken::new();

    vcs::svn_operation(
        &repository,
        SvnOperation::Cleanup {
            break_locks: false,
            remove_unversioned: false,
            remove_ignored: false,
            include_externals: true,
        },
        &token,
    )
    .await
    .unwrap();
    vcs::svn_operation(
        &repository,
        SvnOperation::Lock {
            paths: vec!["locked file.txt".into()],
            message: Some("VersionDock integration lock".into()),
            force: false,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(
        command_output("svn", &["info", "locked file.txt"], &working_copy).contains("Lock Token:")
    );
    vcs::svn_operation(
        &repository,
        SvnOperation::Unlock {
            paths: vec!["locked file.txt".into()],
            force: false,
        },
        &token,
    )
    .await
    .unwrap();

    vcs::svn_operation(
        &repository,
        SvnOperation::Copy {
            source_url: "^/trunk".into(),
            destination_url: "^/branches/release".into(),
            revision: None,
            message: "create release branch".into(),
        },
        &token,
    )
    .await
    .unwrap();
    vcs::svn_operation(
        &repository,
        SvnOperation::Switch {
            url: "^/branches/release".into(),
            revision: None,
            ignore_ancestry: false,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(
        command_output("svn", &["info", "--show-item", "url"], &working_copy)
            .ends_with("/branches/release")
    );

    let trunk_copy = working_parent.path().join("trunk-wc");
    command(
        "svn",
        &[
            "checkout",
            &format!("{repository_url}/trunk"),
            trunk_copy.to_str().unwrap(),
        ],
        working_parent.path(),
    );
    std::fs::write(trunk_copy.join("locked file.txt"), "changed on trunk\n").unwrap();
    command("svn", &["commit", "-m", "change trunk"], &trunk_copy);
    vcs::branch_operation(
        &repository,
        BranchOperation::Merge {
            name: "trunk".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert!(vcs::svn_merge_active(&repository, &token).await);
    assert_eq!(
        read_text(working_copy.join("locked file.txt")),
        "changed on trunk\n"
    );
    vcs::abort_operation(&repository, "merge", &token)
        .await
        .unwrap();
    assert!(!vcs::svn_merge_active(&repository, &token).await);
    assert_eq!(read_text(working_copy.join("locked file.txt")), "content\n");
    std::fs::write(working_copy.join("locked file.txt"), "local dirty\n").unwrap();
    let dirty_error = vcs::branch_operation(
        &repository,
        BranchOperation::Merge {
            name: "trunk".into(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(dirty_error.code, "SVN_WORKING_COPY_NOT_CLEAN");
    command("svn", &["revert", "locked file.txt"], &working_copy);

    let error = vcs::svn_operation(
        &repository,
        SvnOperation::Relocate {
            from_url: "--bad".into(),
            to_url: "file:///safe".into(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_REMOTE_URL");
}

#[tokio::test]
async fn real_git_submodule_lifecycle_supports_uninitialized_modules() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let parent = tempdir().unwrap();
    let source = tempdir().unwrap();
    command("git", &["init", "-b", "main"], parent.path());
    command("git", &["init", "-b", "main"], source.path());
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
    command(
        "git",
        &["config", "protocol.file.allow", "always"],
        parent.path(),
    );
    std::fs::write(source.path().join("module.txt"), "one\n").unwrap();
    command("git", &["add", "."], source.path());
    command("git", &["commit", "-m", "module initial"], source.path());
    command(
        "git",
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            source.path().to_str().unwrap(),
            "vendor/中文 module",
        ],
        parent.path(),
    );
    command("git", &["commit", "-am", "add submodule"], parent.path());
    let repository = repo(parent.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let entries = vcs::submodules(&repository, &token).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "vendor/中文 module");
    assert!(entries[0].initialized);

    vcs::submodule_operation(
        &repository,
        SubmoduleOperation::Deinit {
            path: entries[0].path.clone(),
            force: false,
        },
        &token,
    )
    .await
    .unwrap();
    assert!(!vcs::submodules(&repository, &token).await.unwrap()[0].initialized);
    vcs::submodule_operation(
        &repository,
        SubmoduleOperation::Init {
            path: entries[0].path.clone(),
            recursive: true,
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        read_text(parent.path().join("vendor/中文 module/module.txt")),
        "one\n"
    );

    std::fs::write(source.path().join("module.txt"), "one\ntwo\n").unwrap();
    command("git", &["add", "."], source.path());
    command("git", &["commit", "-m", "module update"], source.path());
    vcs::submodule_operation(
        &repository,
        SubmoduleOperation::Update {
            path: entries[0].path.clone(),
            init: true,
            recursive: true,
            remote: true,
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        read_text(parent.path().join("vendor/中文 module/module.txt")),
        "one\ntwo\n"
    );
    let parent_status = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(parent_status
        .files
        .iter()
        .any(|file| file.path == "vendor/中文 module"
            && file.submodule
            && file.status == "submodule"));
    vcs::submodule_operation(
        &repository,
        SubmoduleOperation::Sync {
            path: entries[0].path.clone(),
            recursive: true,
        },
        &token,
    )
    .await
    .unwrap();
    let error = vcs::submodule_operation(
        &repository,
        SubmoduleOperation::Init {
            path: "../outside".into(),
            recursive: false,
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "SUBMODULE_NOT_FOUND");
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
    let diff = vcs::diff(
        &repository,
        "hello world 中文.txt",
        false,
        None,
        None,
        None,
        &token,
    )
    .await
    .unwrap();
    assert!(!diff.binary);
    vcs::stage(&repository, &["hello world 中文.txt".into()], false, &token)
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
    let diff = vcs::diff(
        &repository,
        "hello world 中文.txt",
        false,
        None,
        None,
        None,
        &token,
    )
    .await
    .unwrap();
    assert!(diff.content.contains("+two"));
    vcs::stage(&repository, &["hello world 中文.txt".into()], false, &token)
        .await
        .unwrap();
    vcs::unstage(&repository, &["hello world 中文.txt".into()], &token)
        .await
        .unwrap();
    vcs::stage(&repository, &["hello world 中文.txt".into()], false, &token)
        .await
        .unwrap();
    vcs::commit(&repository, "second commit", false, &[], &token)
        .await
        .unwrap();
    let history = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert_eq!(history.commits.len(), 2);
    let topology = vcs::history_topology(&repository, 1_000, None, &token)
        .await
        .unwrap();
    assert_eq!(topology.len(), 2);
    assert_eq!(topology[0].hash, history.commits[0].hash);
    assert!(topology[0]
        .refs
        .iter()
        .any(|value| value == "refs/heads/main"));
    assert!(topology[0]
        .refs
        .iter()
        .any(|value| value == "HEAD -> refs/heads/main"));
    let head_detail = vcs::commit_detail(&repository, &history.commits[0].hash, &token)
        .await
        .unwrap();
    assert_eq!(head_detail.branches.is_head, Some(true));
    assert!(head_detail
        .branches
        .local
        .iter()
        .any(|value| value == "main"));
    assert!(!head_detail
        .branches
        .remote
        .iter()
        .any(|value| value.ends_with("/HEAD")));
    let pushed_detail = vcs::commit_detail(&repository, &history.commits[1].hash, &token)
        .await
        .unwrap();
    assert_eq!(pushed_detail.branches.is_head, Some(false));
    assert!(pushed_detail
        .branches
        .remote
        .iter()
        .any(|value| value == "origin/main"));
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
    let feature_topology = vcs::history_topology(&repository, 1_000, None, &token)
        .await
        .unwrap();
    assert!(feature_topology[0]
        .refs
        .iter()
        .any(|value| value == "refs/heads/feature/test"));
    let feature_history = vcs::history(
        &repository,
        0,
        20,
        crate::models::HistoryQuery {
            revision: Some("refs/heads/feature/test".into()),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(feature_history.commits.len(), 2);
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
    assert_eq!(stashes[0].full_message, "integration stash");
    assert_eq!(stashes[0].files.len(), 2);
    let stash_diff = vcs::stash_file_diff(
        &repository,
        &stashes[0].reference,
        "hello world 中文.txt",
        &token,
    )
    .await
    .unwrap();
    assert!(stash_diff.content.contains("+stashed"));
    assert_eq!(stash_diff.language, "text");
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
    assert!(shelves[0]
        .files
        .iter()
        .any(|f| f.path == "shelf untracked.txt"));
    let shelf_diff = shelf::file_diff(
        shelf_storage.path(),
        &repository,
        &shelves[0].id,
        "hello world 中文.txt",
    )
    .await
    .unwrap();
    assert!(shelf_diff.content.contains("+shelved"));
    assert_eq!(shelf_diff.language, "text");
    shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Apply {
            shelf_id: shelves[0].id.clone(),
            paths: None,
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
    std::fs::write(
        Path::new(&linked.path).join("worktree-only.txt"),
        "worktree diff\n",
    )
    .unwrap();
    let worktree_diff = vcs::worktree_diff(
        worktree_storage.path(),
        &repository,
        &linked.path,
        "HEAD",
        &token,
    )
    .await
    .unwrap();
    assert!(worktree_diff
        .files
        .iter()
        .any(|file| file.path == "worktree-only.txt"));
    let worktree_file_diff = vcs::worktree_file_diff(
        worktree_storage.path(),
        &repository,
        &linked.path,
        "HEAD",
        "worktree-only.txt",
        &token,
    )
    .await
    .unwrap();
    assert!(worktree_file_diff.content.contains("+worktree diff"));
    assert_eq!(
        vcs::managed_worktree_path(worktree_storage.path(), &repository, &linked.path, &token)
            .await
            .unwrap(),
        std::fs::canonicalize(&linked.path).unwrap()
    );
    std::fs::remove_file(Path::new(&linked.path).join("worktree-only.txt")).unwrap();
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

    vcs::sync(
        &repository,
        SyncAction::Push,
        None,
        None,
        false,
        &crate::models::DesktopSettings::default(),
        &token,
    )
    .await
    .unwrap();
    vcs::sync(
        &repository,
        SyncAction::Fetch,
        None,
        None,
        false,
        &crate::models::DesktopSettings::default(),
        &token,
    )
    .await
    .unwrap();
    let pull = vcs::sync(
        &repository,
        SyncAction::Pull,
        None,
        None,
        false,
        &crate::models::DesktopSettings::default(),
        &token,
    )
    .await
    .unwrap();
    assert_eq!(pull.update.unwrap().summary.unwrap().commit_count, 0);

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
        true,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(marker_error.code, "UNRESOLVED_MARKERS");
    std::fs::write(directory.path().join("conflict.txt"), "changed elsewhere\n").unwrap();
    let stale = vcs::conflict_save(
        &repository,
        "conflict.txt",
        "resolved\n",
        &versions.fingerprint,
        true,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, "CONFLICT_STALE");
    std::fs::write(directory.path().join("conflict.txt"), &versions.working).unwrap();
    vcs::conflict_save(
        &repository,
        "conflict.txt",
        "resolved\n",
        &versions.fingerprint,
        true,
        &token,
    )
    .await
    .unwrap();
    let resolved = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(!resolved.files.iter().any(|file| file.conflicted));
    assert_eq!(resolved.operation, None);
    assert!(resolved
        .files
        .iter()
        .all(|file| file.path != "conflict.txt"));
    assert!(
        command_output("git", &["log", "-1", "--format=%P"], directory.path())
            .split_whitespace()
            .count()
            >= 2
    );

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
    vcs::conflict_accept(
        &repository,
        "binary.bin",
        ConflictChoice::Theirs,
        true,
        &token,
    )
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
async fn real_git_commit_detail_merge_refs_and_range_diff() {
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
    std::fs::write(directory.path().join("base.txt"), "base\n").unwrap();
    command("git", &["add", "base.txt"], directory.path());
    command("git", &["commit", "-m", "base"], directory.path());
    let base = command_output("git", &["rev-parse", "HEAD"], directory.path());

    command("git", &["switch", "-c", "feature/detail"], directory.path());
    std::fs::write(directory.path().join("feature.txt"), "feature\n").unwrap();
    command("git", &["add", "feature.txt"], directory.path());
    command("git", &["commit", "-m", "feature detail"], directory.path());
    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("main.txt"), "main\n").unwrap();
    command("git", &["add", "main.txt"], directory.path());
    command("git", &["commit", "-m", "main detail"], directory.path());
    command(
        "git",
        &["merge", "--no-ff", "feature/detail", "-m", "merge detail"],
        directory.path(),
    );

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let merge_hash = command_output("git", &["rev-parse", "HEAD"], directory.path());
    let detail = vcs::commit_detail(&repository, &merge_hash, &token)
        .await
        .unwrap();
    assert!(detail.commit.parents.len() >= 2);
    assert!(detail.branches.local.iter().any(|branch| branch == "main"));
    assert!(detail.files.is_empty());
    assert!(detail
        .merge_parent_changes
        .iter()
        .any(|change| change.message == "feature detail" && change.file_count == 1));

    let feature_parent = detail
        .merge_parent_changes
        .iter()
        .find(|change| change.message == "feature detail")
        .unwrap();
    let main_parent = detail
        .merge_parent_changes
        .iter()
        .find(|change| change.message == "main detail")
        .unwrap();

    let feature_diff_files =
        vcs::merge_parent_files(&repository, &merge_hash, &feature_parent.hash, &token)
            .await
            .unwrap();
    assert!(feature_diff_files
        .iter()
        .any(|file| file.path == "main.txt"));

    let main_diff_files =
        vcs::merge_parent_files(&repository, &merge_hash, &main_parent.hash, &token)
            .await
            .unwrap();
    assert!(main_diff_files
        .iter()
        .any(|file| file.path == "feature.txt"));

    let merged = vcs::merge_commits(&repository, &merge_hash, &detail.commit.parents, &token)
        .await
        .unwrap();
    assert!(merged
        .iter()
        .any(|commit| commit.message == "feature detail"));

    vcs::tag_operation(
        &repository,
        TagOperation::Create {
            name: "v-detail".into(),
            revision: Some(merge_hash.clone()),
        },
        &token,
    )
    .await
    .unwrap();
    let tagged = vcs::commit_detail(&repository, &merge_hash, &token)
        .await
        .unwrap();
    assert!(tagged.branches.tags.iter().any(|tag| tag == "v-detail"));

    let range = vcs::diff(
        &repository,
        "feature.txt",
        false,
        None,
        Some(base),
        Some(merge_hash),
        &token,
    )
    .await
    .unwrap();
    assert!(range.content.contains("+feature"));
}

#[tokio::test]
async fn real_svn_core_workflow() {
    if !available("svn") || !available("svnadmin") {
        eprintln!("SKIP: svn or svnadmin not available");
        return;
    }
    let directory = tempdir().unwrap();
    let repository_path = directory.path().join("repository path");
    let checkout = directory.path().join("checkout");
    command(
        "svnadmin",
        &["create", repository_path.to_str().unwrap()],
        directory.path(),
    );
    let url = svn_file_url(&repository_path);
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
    assert_eq!(status.files[0].status, "untracked");
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
    let diff = vcs::diff(
        &repository,
        "中文 file.txt",
        false,
        None,
        None,
        None,
        &token,
    )
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
    let history = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(
        history.commits.len() >= 2,
        "SVN history: {:#?}",
        history.commits
    );
    let topology = vcs::history_topology(&repository, 1_000, None, &token)
        .await
        .unwrap();
    assert!(topology.len() >= 2);
    assert_eq!(topology[0].hash, history.commits[0].hash);
    let first_revision = history
        .commits
        .iter()
        .find(|commit| commit.message == "initial svn commit")
        .map(|commit| commit.hash.clone())
        .unwrap();
    let second_revision = history
        .commits
        .iter()
        .find(|commit| commit.message == "second svn commit")
        .map(|commit| commit.hash.clone())
        .unwrap();
    let detail = vcs::commit_detail(&repository, &first_revision, &token)
        .await
        .unwrap();
    assert_eq!(detail.commit.message, "initial svn commit");
    assert!(detail.files.iter().any(|file| file.path == "中文 file.txt"));
    let range = vcs::diff(
        &repository,
        "中文 file.txt",
        false,
        None,
        Some(first_revision),
        Some(second_revision),
        &token,
    )
    .await
    .unwrap();
    assert!(range.content.contains("+two"));
}

#[tokio::test]
async fn test_vscode_shelf_import_and_backward_compatibility() {
    let directory = tempfile::tempdir().unwrap();
    let shelf_storage = tempfile::tempdir().unwrap();
    let token = CancellationToken::new();
    command("git", &["init", "-b", "main"], directory.path());
    command("git", &["config", "user.name", "Test"], directory.path());
    command(
        "git",
        &["config", "user.email", "test@example.com"],
        directory.path(),
    );
    std::fs::write(directory.path().join("file.txt"), "original\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "init"], directory.path());

    let workspace = crate::models::WorkspaceDescriptor {
        id: "workspace".into(),
        name: "test".into(),
        paths: vec![directory.path().to_string_lossy().into_owned()],
        last_opened_at: "2026-08-20T00:00:00Z".into(),
        available: true,
    };
    let repository = workspace::scan(&workspace, &crate::models::DesktopSettings::default())
        .unwrap()
        .remove(0);

    // Create a mock vscode shelf directory under HOME/Library/Application Support/...
    let local_shelf_dir = shelf_storage.path().join("shelves").join(&repository.id);
    std::fs::create_dir_all(&local_shelf_dir).unwrap();

    // Write a mock shelves.json matching VSCode extension format
    let patch_content = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-original\n+shelved_from_vscode\n";
    std::fs::write(
        local_shelf_dir.join("shelf-1785490774561-a14c6b2f878d.patch"),
        patch_content,
    )
    .unwrap();

    let vscode_json = r#"{
        "shelves": [
            {
                "id": "shelf-1785490774561-a14c6b2f878d",
                "name": "vscode test shelf",
                "date": "2026-07-31T09:39:34.578Z",
                "branch": "dev",
                "files": [
                    {
                        "path": "file.txt",
                        "status": "modified"
                    }
                ],
                "patchFile": "shelf-1785490774561-a14c6b2f878d.patch"
            }
        ]
    }"#;
    std::fs::write(local_shelf_dir.join("shelves.json"), vscode_json).unwrap();

    let shelves = shelf::list(shelf_storage.path(), &repository)
        .await
        .unwrap();
    assert_eq!(shelves.len(), 1);
    assert_eq!(shelves[0].id, "shelf-1785490774561-a14c6b2f878d");
    assert_eq!(shelves[0].name, "vscode test shelf");
    assert_eq!(shelves[0].branch.as_deref(), Some("dev"));
    assert_eq!(shelves[0].created_at, "2026-07-31T09:39:34.578Z");
    assert_eq!(shelves[0].files.len(), 1);
    assert_eq!(shelves[0].files[0].path, "file.txt");
    assert_eq!(shelves[0].files[0].status, "modified");

    // Apply shelf
    shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Apply {
            shelf_id: "shelf-1785490774561-a14c6b2f878d".into(),
            paths: None,
        },
        &token,
    )
    .await
    .unwrap();

    assert_eq!(
        read_text(directory.path().join("file.txt")),
        "shelved_from_vscode\n"
    );

    // Drop shelf
    shelf::operate(
        shelf_storage.path(),
        &repository,
        crate::models::ShelfOperation::Drop {
            shelf_id: "shelf-1785490774561-a14c6b2f878d".into(),
        },
        &token,
    )
    .await
    .unwrap();

    assert!(shelf::list(shelf_storage.path(), &repository)
        .await
        .unwrap()
        .is_empty());
}
