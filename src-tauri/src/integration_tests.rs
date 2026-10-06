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
async fn real_git_diff_binary_markers_in_source_stay_text() {
    use crate::{diff_content, models::CatFileFilterMode};
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    let root = directory.path();
    command("git", &["init", "-b", "main"], root);
    command("git", &["config", "user.name", "Diff Test"], root);
    command("git", &["config", "user.email", "diff@example.test"], root);
    command("git", &["config", "commit.gpgsign", "false"], root);
    std::fs::write(root.join("vcs.rs"), include_str!("vcs.rs")).unwrap();
    std::fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\n\0old").unwrap();
    command("git", &["add", "."], root);
    command("git", &["commit", "-m", "initial source"], root);
    let first = command_output("git", &["rev-parse", "HEAD"], root);
    let repository = repo(root, VcsKind::Git);
    let token = CancellationToken::new();
    let source = format!("{}\n// regression update\n", include_str!("vcs.rs"));
    std::fs::write(root.join("vcs.rs"), &source).unwrap();
    std::fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\n\0new").unwrap();
    for staged in [false, true] {
        if staged {
            command("git", &["add", "."], root);
        }
        let text = diff_content::file_diff(
            &repository,
            "vcs.rs",
            staged,
            None,
            None,
            None,
            &CatFileFilterMode::Filters,
            &token,
        )
        .await
        .unwrap();
        assert!(!text.binary && !text.truncated);
        assert!(text.content.contains("+// regression update"));
        assert!(text.content.contains("GIT binary patch"));
        let binary = diff_content::file_diff(
            &repository,
            "image.png",
            staged,
            None,
            None,
            None,
            &CatFileFilterMode::Filters,
            &token,
        )
        .await
        .unwrap();
        assert!(binary.binary);
    }
    command("git", &["commit", "-m", "updated source"], root);
    let second = command_output("git", &["rev-parse", "HEAD"], root);
    for (revision, from, to) in [
        (Some(first.clone()), None, None),
        (Some(second.clone()), None, None),
        (None, Some(first), Some(second.clone())),
    ] {
        let text = diff_content::file_diff(
            &repository,
            "vcs.rs",
            false,
            revision,
            from,
            to,
            &CatFileFilterMode::Filters,
            &token,
        )
        .await
        .unwrap();
        assert!(!text.binary && !text.truncated);
        assert!(text.content.contains("GIT binary patch"));
    }
    assert!(
        vcs::diff(
            &repository,
            "image.png",
            false,
            Some(second),
            None,
            None,
            &token
        )
        .await
        .unwrap()
        .binary
    );
}

#[tokio::test]
async fn real_svn_diff_binary_markers_in_source_stay_text() {
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let store = directory.path().join("store");
    let wc = directory.path().join("wc");
    command(
        "svnadmin",
        &["create", store.to_str().unwrap()],
        directory.path(),
    );
    let url = format!("file://{}", store.display());
    command(
        "svn",
        &["checkout", &url, wc.to_str().unwrap()],
        directory.path(),
    );
    std::fs::write(wc.join("vcs.rs"), include_str!("vcs.rs")).unwrap();
    std::fs::write(wc.join("image.png"), b"\x89PNG\r\n\x1a\n\0old").unwrap();
    command("svn", &["add", "vcs.rs", "image.png"], &wc);
    command(
        "svn",
        &[
            "propset",
            "svn:mime-type",
            "application/octet-stream",
            "image.png",
        ],
        &wc,
    );
    command("svn", &["commit", "-m", "initial source"], &wc);
    std::fs::write(
        wc.join("vcs.rs"),
        format!("{}\n// regression update\n", include_str!("vcs.rs")),
    )
    .unwrap();
    std::fs::write(wc.join("image.png"), b"\x89PNG\r\n\x1a\n\0new").unwrap();
    let repository = repo(&wc, VcsKind::Svn);
    let token = CancellationToken::new();
    for revision in [None, Some("2".into())] {
        if revision.is_some() {
            command("svn", &["commit", "-m", "updated source"], &wc);
        }
        let text = vcs::diff(
            &repository,
            "vcs.rs",
            false,
            revision.clone(),
            None,
            None,
            &token,
        )
        .await
        .unwrap();
        assert!(!text.binary && !text.truncated);
        assert!(text.content.contains("+// regression update"));
        assert!(text
            .content
            .contains("Cannot display: file marked as a binary type."));
        assert!(
            vcs::diff(
                &repository,
                "image.png",
                false,
                revision,
                None,
                None,
                &token
            )
            .await
            .unwrap()
            .binary
        );
    }
}

#[tokio::test]
async fn real_git_history_author_email_filter_is_case_insensitive() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    command("git", &["init", "-b", "main"], root.path());
    command("git", &["config", "user.name", "Ada"], root.path());
    command(
        "git",
        &["config", "user.email", "Ada@Example.test"],
        root.path(),
    );
    command(
        "git",
        &["commit", "--allow-empty", "-m", "first identity"],
        root.path(),
    );
    command(
        "git",
        &["config", "user.email", "other@example.test"],
        root.path(),
    );
    command(
        "git",
        &["commit", "--allow-empty", "-m", "second identity"],
        root.path(),
    );
    let page = vcs::history(
        &repo(root.path(), VcsKind::Git),
        0,
        100,
        HistoryQuery {
            author: Some("ada@example.test".into()),
            ..Default::default()
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(page.commits.len(), 1);
    assert_eq!(page.commits[0].message, "first identity");
}

#[tokio::test]
async fn real_git_upstream_metadata_avoids_false_errors_and_preserves_tracking() {
    use crate::logger::LogLevel;
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    let working = directory.path().join("working");
    let remote = directory.path().join("remote.git");
    std::fs::create_dir(&working).unwrap();
    command("git", &["init", "-b", "main"], &working);
    // Use a separate bare repository; no application/user checkout is written.
    command(
        "git",
        &["init", "--bare", remote.to_str().unwrap()],
        directory.path(),
    );
    command("git", &["config", "user.name", "Upstream Test"], &working);
    command(
        "git",
        &["config", "user.email", "upstream@example.test"],
        &working,
    );
    command("git", &["commit", "--allow-empty", "-m", "base"], &working);
    let mut repository = repo(&working, VcsKind::Git);
    repository.id = format!("git-upstream-{}", uuid::Uuid::new_v4());
    let token = CancellationToken::new();
    let logger = crate::logger::get_logger()
        .unwrap_or_else(|| crate::logger::init_global_logger(directory.path().join("logs")));
    let base = command_output("git", &["rev-parse", "HEAD"], &working);
    let local_page = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(local_page
        .commits
        .iter()
        .all(|commit| commit.unpushed && !commit.incoming));
    assert!(vcs::incoming_commits(&repository, &token)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        vcs::unpushed_commits(&repository, &token)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(vcs::incoming_changes(&repository, &token)
        .await
        .unwrap()
        .files
        .is_empty());
    assert!(vcs::unpushed_changes(&repository, None, &token)
        .await
        .unwrap()
        .files
        .is_empty());
    command(
        "git",
        &["remote", "add", "origin", remote.to_str().unwrap()],
        &working,
    );
    command(
        "git",
        &["push", "--set-upstream", "origin", "main"],
        &working,
    );
    command("git", &["branch", "incoming", &base], &working);
    command(
        "git",
        &["commit", "--allow-empty", "-m", "local only"],
        &working,
    );
    let local_hash = command_output("git", &["rev-parse", "HEAD"], &working);
    command("git", &["switch", "incoming"], &working);
    command(
        "git",
        &["commit", "--allow-empty", "-m", "remote only"],
        &working,
    );
    let remote_hash = command_output("git", &["rev-parse", "HEAD"], &working);
    command("git", &["push", "origin", "HEAD:main"], &working);
    command("git", &["switch", "main"], &working);
    let page = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(
        page.commits
            .iter()
            .find(|commit| commit.hash == local_hash)
            .unwrap()
            .unpushed
    );
    let incoming = vcs::incoming_commits(&repository, &token).await.unwrap();
    assert_eq!(incoming.len(), 1);
    assert_eq!(incoming[0].hash, remote_hash);
    assert_eq!(
        vcs::unpushed_commits(&repository, &token)
            .await
            .unwrap()
            .len(),
        1
    );
    command("git", &["branch", "--unset-upstream"], &working);
    assert!(vcs::incoming_commits(&repository, &token)
        .await
        .unwrap()
        .is_empty());
    let untracked = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(
        untracked
            .commits
            .iter()
            .find(|commit| commit.hash == local_hash)
            .unwrap()
            .unpushed
    );
    assert!(
        !untracked
            .commits
            .iter()
            .find(|commit| commit.hash == base)
            .unwrap()
            .unpushed
    );
    command("git", &["checkout", "--detach", &local_hash], &working);
    assert!(vcs::incoming_commits(&repository, &token)
        .await
        .unwrap()
        .is_empty());
    let detached = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(detached.commits.iter().all(|commit| !commit.incoming));
    let logs = logger
        .get_entries(None, None, None)
        .into_iter()
        .filter(|entry| entry.cwd.as_deref() == working.to_str())
        .collect::<Vec<_>>();
    assert!(
        !logs.iter().any(|entry| entry.level == LogLevel::Error),
        "{logs:#?}"
    );
    assert!(!logs
        .iter()
        .any(|entry| entry.message.contains("@{upstream}")
            || entry.message.contains("<redacted-email>")));
    // A missing tracking ref falls back just like the plugin's failed @{u} probe.
    command("git", &["switch", "main"], &working);
    command(
        "git",
        &["branch", "--set-upstream-to=origin/main"],
        &working,
    );
    command(
        "git",
        &["update-ref", "-d", "refs/remotes/origin/main"],
        &working,
    );
    assert!(vcs::incoming_commits(&repository, &token)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        vcs::unpushed_commits(&repository, &token)
            .await
            .unwrap()
            .len(),
        2
    );
    let missing_tracking_page = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(missing_tracking_page
        .commits
        .iter()
        .all(|commit| commit.unpushed && !commit.incoming));
    assert!(vcs::incoming_changes(&repository, &token)
        .await
        .unwrap()
        .files
        .is_empty());
    assert!(vcs::unpushed_changes(&repository, None, &token)
        .await
        .unwrap()
        .files
        .is_empty());
    let skipped = vcs::sync(
        &repository,
        SyncAction::PullRebase,
        None,
        None,
        false,
        &crate::models::DesktopSettings::default(),
        &token,
    )
    .await
    .unwrap();
    assert!(skipped.output.contains("skipped"));
    assert!(!logger
        .get_entries(None, None, None)
        .iter()
        .any(|entry| entry.cwd.as_deref() == working.to_str() && entry.level == LogLevel::Error));
}

#[tokio::test]
async fn real_svn_optional_probes_and_incoming_revision_bounds() {
    use crate::logger::{LogLevel, LogManager};
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let store = directory.path().join("store");
    let wc = directory.path().join("wc");
    command(
        "svnadmin",
        &["create", store.to_str().unwrap()],
        directory.path(),
    );
    let url = svn_file_url(&store);
    command(
        "svn",
        &["checkout", &url, wc.to_str().unwrap()],
        directory.path(),
    );
    std::fs::write(wc.join("plain.txt"), "plain text\n").unwrap();
    std::fs::write(wc.join("mime.txt"), "looks like text\n").unwrap();
    std::fs::write(wc.join("special.txt"), "link target\n").unwrap();
    command("svn", &["add", "plain.txt", "mime.txt", "special.txt"], &wc);
    command("svn", &["commit", "-m", "initial"], &wc);
    command("svn", &["update"], &wc);
    let logger: std::sync::Arc<LogManager> = crate::logger::get_logger()
        .unwrap_or_else(|| crate::logger::init_global_logger(directory.path().join("logs")));
    let mut repository = repo(&wc, VcsKind::Svn);
    repository.id = format!("svn-probes-{}", uuid::Uuid::new_v4());
    let token = CancellationToken::new();
    assert!(!vcs::is_svn_conflict_binary(&repository, "plain.txt", &token).await);
    command(
        "svn",
        &[
            "propset",
            "svn:mime-type",
            "application/octet-stream",
            "mime.txt",
        ],
        &wc,
    );
    assert!(vcs::is_svn_conflict_binary(&repository, "mime.txt", &token).await);
    command(
        "svn",
        &["propset", "svn:mime-type", "text/plain", "mime.txt"],
        &wc,
    );
    assert!(!vcs::is_svn_conflict_binary(&repository, "mime.txt", &token).await);
    command("svn", &["propset", "svn:special", "*", "special.txt"], &wc);
    assert!(vcs::is_svn_conflict_binary(&repository, "special.txt", &token).await);

    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 0);
    // A second working copy advances HEAD without updating the tested copy.
    let upstream = directory.path().join("upstream");
    command(
        "svn",
        &["checkout", &url, upstream.to_str().unwrap()],
        directory.path(),
    );
    for message in ["second", "third"] {
        std::fs::write(upstream.join("plain.txt"), message).unwrap();
        command("svn", &["commit", "-m", message], &upstream);
    }
    vcs::invalidate_svn_ref_caches(&repository.id);
    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 2);
    command("svn", &["update"], &wc);
    vcs::invalidate_svn_ref_caches(&repository.id);
    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 0);

    let branches = vcs::branches(&repository, &token).await.unwrap();
    assert_eq!(branches.len(), 1);
    assert!(vcs::tags(&repository, &token).await.unwrap().is_empty());
    let entries = || {
        logger
            .get_entries(None, None, None)
            .into_iter()
            .filter(|entry| entry.cwd.as_deref() == wc.to_str())
            .collect::<Vec<_>>()
    };
    let logs = entries();
    assert!(
        !logs.iter().any(|entry| entry.level == LogLevel::Error),
        "{logs:#?}"
    );
    for target in ["^/trunk", "^/branches", "^/tags"] {
        let probe = logs
            .iter()
            .rev()
            .find(|entry| entry.message.ends_with(target))
            .unwrap();
        assert_eq!(probe.level, LogLevel::Debug);
        assert_eq!(probe.exit_code, Some(1));
    }
    // Ordinary user commands keep their missing-path failures as ERROR.
    let missing = vec![
        "--non-interactive".into(),
        "ls".into(),
        "--xml".into(),
        "^/tags".into(),
    ];
    crate::cli::run(
        "svn",
        &missing,
        &wc,
        None,
        crate::cli::DEFAULT_TIMEOUT,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(entries().last().unwrap().level, LogLevel::Error);
    vcs::invalidate_svn_ref_caches(&repository.id);
}

#[tokio::test]
async fn real_svn_incoming_counts_only_outdated_paths_in_mixed_revision_working_copies() {
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let store = directory.path().join("store");
    let wc = directory.path().join("wc");
    let writer = directory.path().join("writer");
    command(
        "svnadmin",
        &["create", store.to_str().unwrap()],
        directory.path(),
    );
    let url = svn_file_url(&store);
    let trunk = format!("{url}/trunk");
    let outside = format!("{url}/outside");
    command(
        "svn",
        &["mkdir", &trunk, &outside, "-m", "layout"],
        directory.path(),
    );
    command(
        "svn",
        &["checkout", &trunk, wc.to_str().unwrap()],
        directory.path(),
    );
    for name in ["中文 a@.txt", "b%.txt"] {
        std::fs::write(wc.join(name), "base\n").unwrap();
    }
    command("svn", &["add", "中文 a@.txt@", "b%.txt"], &wc);
    command("svn", &["commit", "-m", "base files"], &wc);
    command("svn", &["update"], &wc);
    command(
        "svn",
        &["checkout", &trunk, writer.to_str().unwrap()],
        directory.path(),
    );
    for (file, message) in [
        ("中文 a@.txt", "a first"),
        ("b%.txt", "b first"),
        ("中文 a@.txt", "a second"),
    ] {
        std::fs::write(writer.join(file), message).unwrap();
        command("svn", &["commit", "-m", message], &writer);
    }
    command("svn", &["update", "中文 a@.txt@"], &wc);
    let mut repository = repo(&wc, VcsKind::Svn);
    repository.id = format!("mixed-svn-{}", uuid::Uuid::new_v4());
    let token = CancellationToken::new();
    assert_eq!(command_output("svnversion", &["."], &wc), "2:5");
    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 1);
    // Multiple paths changed in one revision count once, and a completely
    // updated path or another repository subtree must not inflate the count.
    std::fs::write(writer.join("中文 a@.txt"), "a third").unwrap();
    std::fs::write(writer.join("b%.txt"), "b second").unwrap();
    command("svn", &["commit", "-m", "both paths"], &writer);
    command(
        "svn",
        &["mkdir", &format!("{outside}/other"), "-m", "unrelated"],
        directory.path(),
    );
    command("svn", &["update", "中文 a@.txt@"], &wc);
    vcs::invalidate_svn_ref_caches(&repository.id);
    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 2);
    // Property-only remote changes also count as pending updates.
    command(
        "svn",
        &["propset", "parity:test", "value", "b%.txt"],
        &writer,
    );
    command("svn", &["commit", "-m", "remote property"], &writer);
    vcs::invalidate_svn_ref_caches(&repository.id);
    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 3);
    command("svn", &["update"], &wc);
    vcs::invalidate_svn_ref_caches(&repository.id);
    assert_eq!(vcs::svn_incoming_revisions(&repository, &token).await, 0);
    // Exercise the actual background consumer's cache key (highest WC version).
    std::fs::write(writer.join("b%.txt"), "background change").unwrap();
    command("svn", &["commit", "-m", "background change"], &writer);
    vcs::invalidate_svn_ref_caches(&repository.id);
    let effective = vcs::svn_working_copy_info(&repository, &token)
        .await
        .unwrap()
        .revision;
    vcs::svn_incoming_revisions_cached(&repository, &effective);
    for _ in 0..100 {
        if vcs::svn_incoming_cached_behind(&repository.id, &effective) == Some(1) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        vcs::svn_incoming_cached_behind(&repository.id, &effective),
        Some(1)
    );
}

#[tokio::test]
async fn real_git_submodule_unpushed_counts_match_plugin_tracking_fallbacks() {
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    let parent = directory.path().join("parent");
    let source = directory.path().join("source");
    std::fs::create_dir(&parent).unwrap();
    std::fs::create_dir(&source).unwrap();
    for root in [&parent, &source] {
        command("git", &["init", "-b", "main"], root);
        command("git", &["config", "user.name", "Parity QA"], root);
        command("git", &["config", "user.email", "qa@example.test"], root);
    }
    command(
        "git",
        &["commit", "--allow-empty", "-m", "module base"],
        &source,
    );
    let path = "vendor/中文 module";
    command(
        "git",
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            source.to_str().unwrap(),
            path,
        ],
        &parent,
    );
    command("git", &["commit", "-am", "add module"], &parent);
    let module = parent.join(path);
    command("git", &["config", "user.name", "Parity QA"], &module);
    command("git", &["config", "user.email", "qa@example.test"], &module);
    let repository = repo(&parent, VcsKind::Git);
    let token = CancellationToken::new();
    assert_eq!(
        vcs::submodules(&repository, &token).await.unwrap()[0].unpushed_count,
        0
    );
    command(
        "git",
        &["commit", "--allow-empty", "-m", "local one"],
        &module,
    );
    assert_eq!(
        vcs::submodules(&repository, &token).await.unwrap()[0].unpushed_count,
        1
    );
    command("git", &["branch", "--unset-upstream"], &module);
    assert_eq!(
        vcs::submodules(&repository, &token).await.unwrap()[0].unpushed_count,
        1
    );
    command("git", &["branch", "--set-upstream-to=origin/main"], &module);
    command(
        "git",
        &["update-ref", "-d", "refs/remotes/origin/main"],
        &module,
    );
    assert_eq!(
        vcs::submodules(&repository, &token).await.unwrap()[0].unpushed_count,
        2
    );
    command(
        "git",
        &["update-ref", "refs/remotes/origin/main", "HEAD~1"],
        &module,
    );
    command("git", &["checkout", "--detach", "HEAD"], &module);
    command(
        "git",
        &["commit", "--allow-empty", "-m", "local detached"],
        &module,
    );
    let entry = &vcs::submodules(&repository, &token).await.unwrap()[0];
    assert_eq!(entry.current_branch, None);
    assert_eq!(entry.unpushed_count, 2);
    command("git", &["remote", "remove", "origin"], &module);
    assert_eq!(
        vcs::submodules(&repository, &token).await.unwrap()[0].unpushed_count,
        3
    );
}

#[tokio::test]
async fn real_svn_file_kind_probes_preserve_deleted_moved_and_missing_conflicts() {
    use crate::logger::LogLevel;
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let store = directory.path().join("store 中文");
    let wc = directory.path().join("wc");
    let upstream = directory.path().join("upstream");
    command(
        "svnadmin",
        &["create", store.to_str().unwrap()],
        directory.path(),
    );
    let url = svn_file_url(&store);
    command(
        "svn",
        &["checkout", &url, wc.to_str().unwrap()],
        directory.path(),
    );
    let binary_paths = ["move @中文.txt", "delete.txt", "kept.txt", "missing.txt"];
    for name in binary_paths.into_iter().chain(["plain.txt"]) {
        std::fs::write(wc.join(name), "base text\n").unwrap();
        let literal = format!("{name}@");
        command("svn", &["add", "--", &literal], &wc);
        if name != "plain.txt" {
            command(
                "svn",
                &[
                    "propset",
                    "svn:mime-type",
                    "application/octet-stream",
                    "--",
                    &literal,
                ],
                &wc,
            );
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("plain.txt", wc.join("link.txt")).unwrap();
        command("svn", &["add", "link.txt"], &wc);
    }
    command("svn", &["commit", "-m", "base properties"], &wc);
    command("svn", &["update"], &wc);
    command(
        "svn",
        &["checkout", &url, upstream.to_str().unwrap()],
        directory.path(),
    );
    command("svn", &["move", "--", "move @中文.txt@", "moved.txt"], &wc);
    #[cfg(unix)]
    command("svn", &["move", "link.txt", "moved-link.txt"], &wc);
    command("svn", &["delete", "delete.txt", "plain.txt"], &wc);
    command("svn", &["delete", "--keep-local", "kept.txt"], &wc);
    std::fs::remove_file(wc.join("missing.txt")).unwrap();
    command("svn", &["delete", "--", "move @中文.txt@"], &upstream);
    #[cfg(unix)]
    command("svn", &["delete", "link.txt"], &upstream);
    for name in ["delete.txt", "kept.txt", "plain.txt"] {
        std::fs::write(upstream.join(name), "incoming edit\n").unwrap();
    }
    command("svn", &["commit", "-m", "delete and edit"], &upstream);
    command("svn", &["update"], &wc);
    assert!(wc.join("kept.txt").exists());
    // Update may restore a missing file. Keep this probe genuinely missing.
    if wc.join("missing.txt").exists() {
        std::fs::remove_file(wc.join("missing.txt")).unwrap();
    }
    let snapshot = |raw: &str| {
        let document = roxmltree::Document::parse(raw).unwrap();
        document
            .descendants()
            .filter(|node| node.has_tag_name("entry"))
            .map(|entry| {
                let status = entry
                    .children()
                    .find(|node| node.has_tag_name("wc-status"))
                    .unwrap();
                let attributes = status
                    .attributes()
                    .map(|attribute| (attribute.name().to_string(), attribute.value().to_string()))
                    .collect::<std::collections::BTreeMap<_, _>>();
                (entry.attribute("path").unwrap().to_string(), attributes)
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let before = command_output("svn", &["status", "--xml"], &wc);
    let logger = crate::logger::get_logger()
        .unwrap_or_else(|| crate::logger::init_global_logger(directory.path().join("logs")));
    let mut repository = repo(&wc, VcsKind::Svn);
    repository.id = format!("svn-tree-probe-{}", uuid::Uuid::new_v4());
    let token = CancellationToken::new();
    for name in binary_paths {
        assert!(
            vcs::is_svn_conflict_binary(&repository, name, &token).await,
            "properties must survive: {name}"
        );
    }
    assert!(!vcs::is_svn_conflict_binary(&repository, "plain.txt", &token).await);
    #[cfg(unix)]
    assert!(vcs::is_svn_conflict_binary(&repository, "link.txt", &token).await);
    let status = workspace::svn_status(repository.clone(), &token)
        .await
        .unwrap();
    for name in ["move @中文.txt", "delete.txt", "kept.txt", "plain.txt"] {
        let file = status.files.iter().find(|file| file.path == name).unwrap();
        assert!(file.conflicted, "tree conflict must remain visible: {name}");
        assert!(file
            .conflict_types
            .as_ref()
            .unwrap()
            .iter()
            .any(|kind| kind == "tree"));
    }
    assert_eq!(
        snapshot(&before),
        snapshot(&command_output("svn", &["status", "--xml"], &wc))
    );
    let logs = logger
        .get_entries(None, None, None)
        .into_iter()
        .filter(|entry| entry.cwd.as_deref() == wc.to_str())
        .collect::<Vec<_>>();
    assert!(
        !logs.iter().any(|entry| entry.level == LogLevel::Error),
        "{logs:#?}"
    );
    assert!(logs
        .iter()
        .any(|entry| entry.message.contains("proplist") && entry.message.contains("-r BASE")));
    assert!(logs.iter().any(|entry| entry.message.contains("proplist")
        && entry.message.contains("-r 1")
        && entry.message.ends_with("@1")));
    vcs::invalidate_svn_ref_caches(&repository.id);
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

    let default_query = HistoryQuery::default();
    let target_commits = vcs::branch_compare_commits(
        &repository,
        "main",
        "feature/compare",
        "targetOnly",
        0,
        100,
        &default_query,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(target_commits.len(), 1);
    assert_eq!(target_commits[0].message, "feature change");

    // Regex search via --grep
    let regex_query = HistoryQuery {
        text: Some("feat.*change".into()),
        ..Default::default()
    };
    let regex_commits = vcs::branch_compare_commits(
        &repository,
        "main",
        "feature/compare",
        "targetOnly",
        0,
        100,
        &regex_query,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(regex_commits.len(), 1);

    let nomatch_query = HistoryQuery {
        text: Some("nomatch.*".into()),
        ..Default::default()
    };
    let nomatch_commits = vcs::branch_compare_commits(
        &repository,
        "main",
        "feature/compare",
        "targetOnly",
        0,
        100,
        &nomatch_query,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(nomatch_commits.len(), 0);

    // Hash lookup with ancestor checking
    let feature_hash = &target_commits[0].hash;
    let hash_query = HistoryQuery {
        text: Some(feature_hash[..10].into()),
        ..Default::default()
    };
    let hash_in_target = vcs::branch_compare_commits(
        &repository,
        "main",
        "feature/compare",
        "targetOnly",
        0,
        100,
        &hash_query,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(hash_in_target.len(), 1);

    let hash_in_base = vcs::branch_compare_commits(
        &repository,
        "main",
        "feature/compare",
        "baseOnly",
        0,
        100,
        &hash_query,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(hash_in_base.len(), 0);

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
async fn real_git_discard_preserves_staged_changes_for_partially_staged_and_added_files() {
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
    std::fs::write(directory.path().join("tracked.txt"), "base\n").unwrap();
    command("git", &["add", "tracked.txt"], directory.path());
    command("git", &["commit", "-m", "initial"], directory.path());

    // 1. 部分暂存 (MM): 暂存区为 base + staged, 工作区为 base + staged + worktree
    std::fs::write(directory.path().join("tracked.txt"), "base\nstaged\n").unwrap();
    command("git", &["add", "tracked.txt"], directory.path());
    std::fs::write(
        directory.path().join("tracked.txt"),
        "base\nstaged\nworktree\n",
    )
    .unwrap();

    // 2. 新增且暂存 (AM): 暂存区为 newly added, 工作区为 newly added + worktree
    std::fs::write(directory.path().join("added.txt"), "new file in index\n").unwrap();
    command("git", &["add", "added.txt"], directory.path());
    std::fs::write(
        directory.path().join("added.txt"),
        "new file in index\nworktree edit\n",
    )
    .unwrap();

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    vcs::discard(
        &repository,
        &["tracked.txt".into(), "added.txt".into()],
        &token,
    )
    .await
    .unwrap();

    // 验证: 工作区未暂存改动被回滚，但暂存区的改动完好保留！
    assert_eq!(
        read_text(directory.path().join("tracked.txt")),
        "base\nstaged\n"
    );
    assert_eq!(
        read_text(directory.path().join("added.txt")),
        "new file in index\n"
    );

    // 验证 git status 依然保留暂存状态 (M  和 A )，未暂存部分已消除
    let status = command_output("git", &["status", "--porcelain"], directory.path());
    assert!(status.contains("M  tracked.txt"));
    assert!(status.contains("A  added.txt"));
}

#[tokio::test]
async fn real_svn_discard_added_directory_preserves_unversioned_files() {
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
    let directory = checkout.join("new_dir");
    std::fs::create_dir(&directory).unwrap();
    // 将 new_dir 加入 SVN
    command("svn", &["add", "new_dir"], &checkout);
    // 在 new_dir 中创建未纳管的文件（不执行 svn add）
    std::fs::write(directory.join("unversioned.txt"), "important data\n").unwrap();

    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();
    // 回滚 new_dir
    vcs::discard(&repository, &["new_dir".into()], &token)
        .await
        .unwrap();

    // 验证未纳管文件没有被清掉
    assert!(directory.join("unversioned.txt").exists());
    assert_eq!(
        read_text(directory.join("unversioned.txt")),
        "important data\n"
    );
}

#[tokio::test]
async fn real_git_commit_staged_only_excludes_unstaged_working_tree_changes() {
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
    std::fs::write(directory.path().join("file.txt"), "base\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "initial"], directory.path());

    // 暂存部分行
    std::fs::write(directory.path().join("file.txt"), "base\nstaged line\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    // 在工作区写入未暂存行（MM 状态）
    std::fs::write(
        directory.path().join("file.txt"),
        "base\nstaged line\nunstaged line\n",
    )
    .unwrap();

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // staged_only: true 进行提交
    let revision = vcs::commit_with_identity(
        &repository,
        "commit staged only",
        false,
        &["file.txt".into()],
        None,
        false,
        true, // staged_only = true
        &token,
    )
    .await
    .unwrap();

    // 验证提交中的内容严格只有暂存的内容，不包含 unstaged line
    let committed_content = command_output(
        "git",
        &["show", &format!("{revision}:file.txt")],
        directory.path(),
    );
    assert_eq!(committed_content, "base\nstaged line");

    // 验证工作区依然保留未暂存的内容
    assert_eq!(
        read_text(directory.path().join("file.txt")),
        "base\nstaged line\nunstaged line\n"
    );
    let raw_status = String::from_utf8_lossy(
        &std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(directory.path())
            .output()
            .unwrap()
            .stdout,
    )
    .to_string();
    assert!(raw_status.starts_with(" M file.txt"));
}

#[tokio::test]
async fn real_git_unstage_unexpected_cached_excludes_external_staged_files() {
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
    std::fs::write(directory.path().join("file_a.txt"), "initial a\n").unwrap();
    std::fs::write(directory.path().join("file_b.txt"), "initial b\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "initial commit"], directory.path());

    // file_a 发生变更并暂存（预期提交）
    std::fs::write(directory.path().join("file_a.txt"), "updated a\n").unwrap();
    command("git", &["add", "file_a.txt"], directory.path());

    // 模拟外部工具（或后台并发）暂存了 file_b（非本次提交预期文件）
    std::fs::write(directory.path().join("file_b.txt"), "updated b\n").unwrap();
    command("git", &["add", "file_b.txt"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // 执行 unstage_unexpected_cached，传入 expected = ["file_a.txt"]
    vcs::unstage_unexpected_cached(&repository, &["file_a.txt".into()], &[], &token)
        .await
        .unwrap();

    // 验证暂存区只剩 file_a.txt，file_b.txt 已被 unstage 到工作区
    let status_raw = command_output("git", &["status", "--porcelain"], directory.path());
    assert!(status_raw.contains("M  file_a.txt"));
    assert!(status_raw.contains(" M file_b.txt"));

    // 提交预期文件
    let revision = vcs::commit_with_identity(
        &repository,
        "commit expected a only",
        false,
        &["file_a.txt".into()],
        None,
        false,
        true,
        &token,
    )
    .await
    .unwrap();

    // 验证提交中仅有 file_a.txt
    let diff_tree = command_output(
        "git",
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            &revision,
        ],
        directory.path(),
    );
    assert_eq!(diff_tree.trim(), "file_a.txt");
    // 验证 file_b.txt 的修改依然完整保留在工作区
    assert_eq!(
        read_text(directory.path().join("file_b.txt")),
        "updated b\n"
    );
}

#[tokio::test]
async fn real_git_unstage_unexpected_cached_excludes_unselected_rename_without_committing_deletion()
{
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
    std::fs::write(directory.path().join("old.txt"), "original old content\n").unwrap();
    std::fs::write(directory.path().join("selected.txt"), "initial selected\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "initial commit"], directory.path());

    // 暂存重命名 old.txt -> new.txt
    command("git", &["mv", "old.txt", "new.txt"], directory.path());

    // 修改并暂存 selected.txt
    std::fs::write(directory.path().join("selected.txt"), "updated selected\n").unwrap();
    command("git", &["add", "selected.txt"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // 仅选中提交 selected.txt，不提交重命名
    vcs::unstage_unexpected_cached(&repository, &["selected.txt".into()], &[], &token)
        .await
        .unwrap();

    // 提交预期文件 selected.txt
    let revision = vcs::commit_with_identity(
        &repository,
        "commit selected only",
        false,
        &["selected.txt".into()],
        None,
        false,
        true,
        &token,
    )
    .await
    .unwrap();

    // 核心验证：提交生成的 revision 中仅包含 selected.txt，绝不包含 old.txt 的删除！
    let diff_tree = command_output(
        "git",
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            &revision,
        ],
        directory.path(),
    );
    assert_eq!(diff_tree.trim(), "selected.txt");

    // 验证 HEAD 中依然完整保留 old.txt
    let show_old = command_output("git", &["show", "HEAD:old.txt"], directory.path());
    assert_eq!(show_old, "original old content");

    // 验证 new.txt 依然保留在工作区
    assert_eq!(
        read_text(directory.path().join("new.txt")),
        "original old content\n"
    );
}

#[tokio::test]
async fn real_git_inspect_staged_file_for_safety_uses_index_content() {
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
    command(
        "git",
        &["config", "core.autocrlf", "false"],
        directory.path(),
    );

    // 1. CRLF 验证：暂存区为 CRLF，工作区已被改回 LF
    std::fs::write(directory.path().join("crlf.txt"), "line1\r\nline2\r\n").unwrap();
    command("git", &["add", "crlf.txt"], directory.path());
    std::fs::write(directory.path().join("crlf.txt"), "line1\nline2\n").unwrap();

    // 2. 文件大小验证：暂存区为 10 字节，工作区被追加至 500 字节
    std::fs::write(directory.path().join("size.txt"), "0123456789").unwrap();
    command("git", &["add", "size.txt"], directory.path());
    std::fs::write(directory.path().join("size.txt"), "0123456789".repeat(50)).unwrap();

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // 验证 crlf.txt 检查结果来源于 index，能够成功发现 CRLF
    let crlf_info = vcs::inspect_staged_file_for_safety(&repository, "crlf.txt", true, &token)
        .await
        .unwrap();
    assert!(crlf_info.is_some());
    let (_, has_crlf) = crlf_info.unwrap();
    assert!(
        has_crlf,
        "Should detect CRLF in staged index despite disk file having LF"
    );

    // 验证 size.txt 检查出的大小严格为 10 字节，而不是工作区的 500 字节
    let size_info = vcs::inspect_staged_file_for_safety(&repository, "size.txt", false, &token)
        .await
        .unwrap();
    assert!(size_info.is_some());
    let (staged_size, _) = size_info.unwrap();
    assert_eq!(
        staged_size, 10,
        "Should inspect staged index size (10 bytes), not disk size (500 bytes)"
    );
}

#[tokio::test]
async fn real_git_stash_operation_aborts_if_reference_hash_moved() {
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

    // 初始提交
    std::fs::write(directory.path().join("base.txt"), "base\n").unwrap();
    command("git", &["add", "base.txt"], directory.path());
    command("git", &["commit", "-m", "initial commit"], directory.path());

    // 创建第一份暂存 stash 1
    std::fs::write(directory.path().join("file1.txt"), "file1\n").unwrap();
    command("git", &["add", "file1.txt"], directory.path());
    command("git", &["stash", "push", "-m", "stash 1"], directory.path());

    // 创建第二份暂存 stash 2
    std::fs::write(directory.path().join("file2.txt"), "file2\n").unwrap();
    command("git", &["add", "file2.txt"], directory.path());
    command("git", &["stash", "push", "-m", "stash 2"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    let stashes = vcs::stashes(&repository, &token).await.unwrap();
    assert_eq!(stashes.len(), 2);
    let stash1_hash = stashes[1].hash.clone();
    let stash2_hash = stashes[0].hash.clone();

    // 尝试以 "stash@{0}" 为引用，但传入 stash 1 的 hash（模拟序号发生偏移错位）
    let drop_err = vcs::stash_operation(
        &repository,
        StashOperation::Drop {
            reference: "stash@{0}".into(),
            expected_hash: Some(stash1_hash.clone()),
        },
        &token,
    )
    .await
    .unwrap_err();

    assert_eq!(drop_err.code, "STASH_REFERENCE_MOVED");

    // 核心断言：由于校验不匹配被坚决阻断，两份暂存均完好无损保留！
    let stashes_after_abort = vcs::stashes(&repository, &token).await.unwrap();
    assert_eq!(stashes_after_abort.len(), 2);
    assert_eq!(stashes_after_abort[0].hash, stash2_hash);
    assert_eq!(stashes_after_abort[1].hash, stash1_hash);

    // 传入匹配的 expected_hash，验证可正常执行删除
    vcs::stash_operation(
        &repository,
        StashOperation::Drop {
            reference: "stash@{0}".into(),
            expected_hash: Some(stash2_hash),
        },
        &token,
    )
    .await
    .unwrap();

    let remaining_stashes = vcs::stashes(&repository, &token).await.unwrap();
    assert_eq!(remaining_stashes.len(), 1);
    assert_eq!(remaining_stashes[0].hash, stash1_hash);
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
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();
    let unpublished = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(unpublished.commits.iter().all(|commit| commit.unpushed));

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

    let tracked = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert_eq!(tracked.commits.len(), 2);
    assert!(tracked.commits[0].unpushed);
    assert!(!tracked.commits[1].unpushed);
    command("git", &["branch", "--unset-upstream"], directory.path());
    let untracked_branch = vcs::history(&repository, 0, 20, Default::default(), &token)
        .await
        .unwrap();
    assert!(untracked_branch.commits[0].unpushed);
    assert!(!untracked_branch.commits[1].unpushed);
    command(
        "git",
        &["branch", "--set-upstream-to=origin/main"],
        directory.path(),
    );

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
        &crate::models::DesktopSettings {
            update_project_clean_working_tree: crate::models::CleanWorkingTreeMethod::Stash,
            ..Default::default()
        },
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

#[cfg(unix)]
#[tokio::test]
async fn real_git_cancelled_update_restores_local_changes_before_returning() {
    use std::os::unix::fs::PermissionsExt;
    if !available("git") {
        return;
    }
    for method in [
        crate::models::CleanWorkingTreeMethod::Stash,
        crate::models::CleanWorkingTreeMethod::Shelve,
    ] {
        let preserves_index = matches!(method, crate::models::CleanWorkingTreeMethod::Stash);
        let root = tempdir().unwrap();
        let remote = root.path().join("remote.git");
        let working = root.path().join("working");
        command(
            "git",
            &["init", "--bare", remote.to_str().unwrap()],
            root.path(),
        );
        command(
            "git",
            &["init", "-b", "main", working.to_str().unwrap()],
            root.path(),
        );
        command(
            "git",
            &["config", "user.name", "VersionDock Test"],
            &working,
        );
        command(
            "git",
            &["config", "user.email", "test@example.test"],
            &working,
        );
        std::fs::write(working.join("local.txt"), "base\n").unwrap();
        command("git", &["add", "."], &working);
        command("git", &["commit", "-m", "base"], &working);
        command(
            "git",
            &["remote", "add", "origin", remote.to_str().unwrap()],
            &working,
        );
        command("git", &["push", "-u", "origin", "main"], &working);
        std::fs::write(working.join("local.txt"), "staged\n").unwrap();
        command("git", &["add", "local.txt"], &working);
        std::fs::write(working.join("local.txt"), "unstaged\n").unwrap();
        std::fs::write(working.join("untracked.txt"), "untracked\n").unwrap();

        // Hold the real local transport after backup capture, then cancel it.
        let marker = root.path().join("transport-started");
        let transport = root.path().join("slow-upload-pack");
        std::fs::write(
            &transport,
            format!(
                "#!/bin/sh\ntouch '{}'\nsleep 10\nexec git-upload-pack \"$@\"\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&transport, std::fs::Permissions::from_mode(0o755)).unwrap();
        command(
            "git",
            &[
                "config",
                "remote.origin.uploadpack",
                transport.to_str().unwrap(),
            ],
            &working,
        );
        let token = CancellationToken::new();
        let cancelling = token.clone();
        let cancel = tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(8), async {
                while !marker.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("real fetch must start after capturing local changes");
            cancelling.cancel();
        });
        let error = vcs::sync_with_worktree_backup(
            root.path(),
            &repo(&working, VcsKind::Git),
            SyncAction::Pull,
            None,
            None,
            false,
            &crate::models::DesktopSettings {
                update_project_clean_working_tree: method,
                ..Default::default()
            },
            &token,
        )
        .await
        .unwrap_err();
        cancel.await.unwrap();
        assert_eq!(error.code, "REQUEST_CANCELLED");
        assert_eq!(read_text(working.join("local.txt")), "unstaged\n");
        if preserves_index {
            assert!(
                command_output("git", &["diff", "--cached", "--", "local.txt"], &working)
                    .contains("+staged")
            );
            assert!(
                command_output("git", &["diff", "--", "local.txt"], &working).contains("+unstaged")
            );
        }
        assert_eq!(read_text(working.join("untracked.txt")), "untracked\n");
        assert!(command_output("git", &["stash", "list"], &working).is_empty());
        assert!(shelf::list(root.path(), &repo(&working, VcsKind::Git))
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn real_git_pull_auto_shelf_keeps_backup_when_restore_conflicts() {
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

    let error = vcs::sync_with_worktree_backup(
        root.path(),
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

    assert_eq!(error.code, "GIT_UPDATE_CONFLICT");
    assert!(error
        .restore_warning
        .as_ref()
        .is_some_and(|warning| warning.shelf && warning.conflicted));
    assert!(!shelf::list(root.path(), &repo(&working, VcsKind::Git))
        .await
        .unwrap()
        .is_empty());
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

    vcs::unpushed_operation(
        &repository,
        UnpushedOperation::UndoHead {
            expected_hash: None,
        },
        &token,
    )
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
            expected_branch: None,
            expected_head: None,
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
            expected_branch: None,
            expected_head: None,
        },
        false,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "INVALID_RESET_MODE");
}

#[tokio::test]
async fn real_git_history_with_line_range_returns_expected_commits() {
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
    let file_path = directory.path().join("file.txt");
    std::fs::write(&file_path, "line 1\nline 2\nline 3\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "first commit"], directory.path());
    let commit1 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    std::fs::write(&file_path, "line 1 modified\nline 2\nline 3\n").unwrap();
    command(
        "git",
        &["commit", "-am", "second commit: modify line 1"],
        directory.path(),
    );
    let commit2 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    std::fs::write(&file_path, "line 1 modified\nline 2\nline 3 modified\n").unwrap();
    command(
        "git",
        &["commit", "-am", "third commit: modify line 3"],
        directory.path(),
    );
    let commit3 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // Query line 1 history: should include commit2 and commit1, but NOT commit3
    let page = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("file.txt".into()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes = page
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes.contains(&commit2.as_str()));
    assert!(hashes.contains(&commit1.as_str()));
    assert!(!hashes.contains(&commit3.as_str()));

    // Query line 3 history: should include commit3 and commit1, but NOT commit2
    let page3 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("file.txt".into()),
            line_range: Some(crate::models::LineRange { start: 3, end: 3 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes3 = page3
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes3.contains(&commit3.as_str()));
    assert!(hashes3.contains(&commit1.as_str()));
    assert!(!hashes3.contains(&commit2.as_str()));
}

#[tokio::test]
async fn real_git_history_with_line_range_on_renamed_file_and_worktree_revision() {
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

    let old_file = directory.path().join("old_name.txt");
    std::fs::write(&old_file, "line 1\nline 2\nline 3\n").unwrap();
    command("git", &["add", "old_name.txt"], directory.path());
    command(
        "git",
        &["commit", "-m", "first commit (c1)"],
        directory.path(),
    );
    let commit1 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    std::fs::write(&old_file, "line 1 modified\nline 2\nline 3\n").unwrap();
    command(
        "git",
        &["commit", "-am", "second commit: modify line 1 (c2)"],
        directory.path(),
    );
    let commit2 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    command(
        "git",
        &["mv", "old_name.txt", "new_name.txt"],
        directory.path(),
    );
    command(
        "git",
        &["commit", "-m", "third commit: rename to new_name.txt (c3)"],
        directory.path(),
    );
    let commit3 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // 1. WORKTREE revision should be normalized to HEAD without throwing unknown revision error
    let worktree_page = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("new_name.txt".into()),
            revision: Some("WORKTREE".into()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();
    assert!(!worktree_page.commits.is_empty());
    let worktree_hashes = worktree_page
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(worktree_hashes.contains(&commit2.as_str()));

    // 2. Querying old revision (c2) with new_name.txt must fail because new_name.txt does not exist in c2
    let fail_new_name = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("new_name.txt".into()),
            revision: Some(commit2.clone()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await;
    assert!(fail_new_name.is_err());

    // 3. Querying old revision (c2) with historical old_name.txt succeeds and finds c2 and c1
    let success_old_name = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("old_name.txt".into()),
            revision: Some(commit2.clone()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let old_hashes = success_old_name
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(old_hashes.contains(&commit2.as_str()));
    assert!(old_hashes.contains(&commit1.as_str()));
    assert!(!old_hashes.contains(&commit3.as_str()));
}

#[tokio::test]
async fn real_svn_history_with_line_range_returns_expected_commits() {
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
    let checkout = checkout_parent.path().join("svn_wc");
    command(
        "svn",
        &["checkout", &url, checkout.to_str().unwrap()],
        checkout_parent.path(),
    );

    let file_path = checkout.join("file.txt");
    std::fs::write(&file_path, "line 1\nline 2\nline 3\n").unwrap();
    command("svn", &["add", "file.txt"], &checkout);
    command("svn", &["commit", "-m", "first commit"], &checkout);

    std::fs::write(&file_path, "line 1 modified\nline 2\nline 3\n").unwrap();
    command(
        "svn",
        &["commit", "-m", "second commit: modify line 1"],
        &checkout,
    );

    std::fs::write(&file_path, "line 1 modified\nline 2\nline 3 modified\n").unwrap();
    command(
        "svn",
        &["commit", "-m", "third commit: modify line 3"],
        &checkout,
    );

    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();

    // Query line 1 history: in WC, line 1 was last modified by r2
    let page1 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("file.txt".into()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes1 = page1
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes1.contains(&"2"));
    assert!(!hashes1.contains(&"1"));
    assert!(!hashes1.contains(&"3"));

    // Query lines 1..=2 history: line 1 from r2, line 2 from r1 -> should include r2 and r1, but NOT r3
    let page1_2 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("file.txt".into()),
            line_range: Some(crate::models::LineRange { start: 1, end: 2 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes1_2 = page1_2
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes1_2.contains(&"2"));
    assert!(hashes1_2.contains(&"1"));
    assert!(!hashes1_2.contains(&"3"));

    // Query line 3 history: in WC, line 3 was last modified by r3 -> should include r3, but NOT r1 or r2
    let page3 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("file.txt".into()),
            line_range: Some(crate::models::LineRange { start: 3, end: 3 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes3 = page3
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes3.contains(&"3"));
    assert!(!hashes3.contains(&"1"));
    assert!(!hashes3.contains(&"2"));

    // Query line 3 history at revision 2: at r2, line 3 was created by r1 (not yet modified by r3)
    let page3_r2 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("file.txt".into()),
            revision: Some("2".into()),
            line_range: Some(crate::models::LineRange { start: 3, end: 3 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes3_r2 = page3_r2
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes3_r2.contains(&"1"));
    assert!(!hashes3_r2.contains(&"3"));
    assert!(!hashes3_r2.contains(&"2"));
    command("svn", &["update", "-r", "1"], &checkout);
    let incoming_page = vcs::history(&repository, 0, 10, Default::default(), &token)
        .await
        .unwrap();
    assert!(
        incoming_page
            .commits
            .iter()
            .find(|commit| commit.hash == "3")
            .unwrap()
            .incoming
    );
    assert!(
        !incoming_page
            .commits
            .iter()
            .find(|commit| commit.hash == "1")
            .unwrap()
            .incoming
    );
}

#[tokio::test]
async fn real_svn_history_with_line_range_on_deleted_file_returns_commits_at_selected_revision() {
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
    let checkout = checkout_parent.path().join("svn_wc_del");
    command(
        "svn",
        &["checkout", &url, checkout.to_str().unwrap()],
        checkout_parent.path(),
    );

    let file_path = checkout.join("del.txt");
    std::fs::write(&file_path, "line 1\nline 2\nline 3\n").unwrap();
    command("svn", &["add", "del.txt"], &checkout);
    command("svn", &["commit", "-m", "first commit (r1)"], &checkout);

    std::fs::write(&file_path, "line 1 modified\nline 2\nline 3\n").unwrap();
    command(
        "svn",
        &["commit", "-m", "second commit: modify line 1 (r2)"],
        &checkout,
    );

    command("svn", &["delete", "del.txt"], &checkout);
    command(
        "svn",
        &["commit", "-m", "third commit: delete del.txt (r3)"],
        &checkout,
    );

    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();

    // 1. Without revision on deleted file: svn blame must fail and error is preserved (not swallowed into empty)
    let unpinned = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("del.txt".into()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await;
    assert!(unpinned.is_err());

    // 2. With selected revision "2": should locate file at peg revision 2 and return r2 for line 1
    let pinned_r2_line1 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("del.txt".into()),
            revision: Some("2".into()),
            line_range: Some(crate::models::LineRange { start: 1, end: 1 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes_r2_line1 = pinned_r2_line1
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes_r2_line1.contains(&"2"));
    assert!(!hashes_r2_line1.contains(&"3"));

    // 3. With selected revision "2": should return r1 for line 2
    let pinned_r2_line2 = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("del.txt".into()),
            revision: Some("2".into()),
            line_range: Some(crate::models::LineRange { start: 2, end: 2 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    let hashes_r2_line2 = pinned_r2_line2
        .commits
        .iter()
        .map(|c| c.hash.as_str())
        .collect::<Vec<_>>();
    assert!(hashes_r2_line2.contains(&"1"));
    assert!(!hashes_r2_line2.contains(&"2"));
    assert!(!hashes_r2_line2.contains(&"3"));
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

    std::fs::create_dir(working_copy.join("nested")).unwrap();
    command("svn", &["add", "nested"], &working_copy);
    command(
        "svn",
        &["commit", "-m", "nested ignore directory"],
        &working_copy,
    );
    vcs::update_ignore_rules(
        &repository,
        "",
        &["*.tmp".into(), "keep.txt".into()],
        &token,
    )
    .await
    .unwrap();
    vcs::update_ignore_rules(
        &repository,
        "nested",
        &["cache".into(), "keep".into()],
        &token,
    )
    .await
    .unwrap();
    let ignore_groups = vcs::svn_ignore_entries(&repository, &token).await.unwrap();
    assert_eq!(ignore_groups.len(), 2);
    assert!(ignore_groups
        .iter()
        .any(|group| group.directory.is_empty() && group.patterns.contains(&"*.tmp".into())));
    assert!(ignore_groups
        .iter()
        .any(|group| group.directory == "nested" && group.patterns.contains(&"cache".into())));
    vcs::svn_operation(
        &repository,
        SvnOperation::RemoveIgnoreEntries {
            entries: vec![
                crate::models::IgnoreRules {
                    directory: "".into(),
                    source: "svn:ignore".into(),
                    patterns: vec!["*.tmp".into()],
                },
                crate::models::IgnoreRules {
                    directory: "nested".into(),
                    source: "svn:ignore".into(),
                    patterns: vec!["cache".into()],
                },
            ],
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        vcs::ignore_rules(&repository, "", &token)
            .await
            .unwrap()
            .patterns,
        ["keep.txt"]
    );
    assert_eq!(
        vcs::ignore_rules(&repository, "nested", &token)
            .await
            .unwrap()
            .patterns,
        ["keep"]
    );
    assert!(vcs::svn_operation(
        &repository,
        SvnOperation::RemoveIgnoreEntries {
            entries: vec![crate::models::IgnoreRules {
                directory: "../outside".into(),
                source: "svn:ignore".into(),
                patterns: vec!["keep".into()]
            },]
        },
        &token
    )
    .await
    .is_err());

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

    let ws = workspace::descriptor(vec![parent.path().to_string_lossy().into_owned()]).unwrap();
    let discovered = workspace::scan(&ws, &crate::models::DesktopSettings::default()).unwrap();
    let child_meta = discovered.iter().find(|meta| meta.is_submodule).unwrap();
    assert!(
        !child_meta.is_worktree,
        "a submodule gitfile is not a linked worktree"
    );

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
    let discovered = workspace::scan(&ws, &crate::models::DesktopSettings::default()).unwrap();
    assert_eq!(
        discovered.len(),
        1,
        "the empty deinitialized directory must not be reported as its parent Git repository"
    );

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
    let topology = vcs::history_topology(&repository, None, 1_000, None, &token)
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
    assert_eq!(head_detail.branches_pending, Some(true));
    let head_branches = vcs::commit_branches(&repository, &history.commits[0].hash, &token)
        .await
        .unwrap();
    assert_eq!(head_branches.is_head, Some(true));
    assert!(head_branches.local.iter().any(|value| value == "main"));
    assert!(!head_branches
        .remote
        .iter()
        .any(|value| value.ends_with("/HEAD")));
    let pushed_detail = vcs::commit_detail(&repository, &history.commits[1].hash, &token)
        .await
        .unwrap();
    let pushed_branches = vcs::commit_branches(&repository, &pushed_detail.commit.hash, &token)
        .await
        .unwrap();
    assert_eq!(pushed_branches.is_head, Some(false));
    assert!(pushed_branches
        .remote
        .iter()
        .any(|value| value == "origin/main"));
    vcs::branch_operation(
        &repository,
        BranchOperation::Create {
            name: "feature/test".into(),
            from: None,
            checkout: None,
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
    let feature_topology = vcs::history_topology(&repository, None, 1_000, None, &token)
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
            expected_hash: None,
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
            expected_hash: None,
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
            expected_hash: None,
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
    // Plugin shelves apply with --3way, so the new path is staged and reset
    // removes it along with the other restored changes.
    assert!(!directory.path().join("shelf untracked.txt").exists());
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
            path: worktree_storage
                .path()
                .join("linked")
                .to_string_lossy()
                .into_owned(),
            branch: "worktree/integration".into(),
            new_branch: true,
            commitish: None,
            no_track: false,
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
            reason: None,
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
        false,
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
        false,
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
        false,
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
async fn real_git_rebase_conflict_continue_and_abort_guards() {
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
        &["config", "user.email", "test@versiondock.com"],
        directory.path(),
    );
    command(
        "git",
        &["config", "commit.gpgsign", "false"],
        directory.path(),
    );
    std::fs::write(directory.path().join("file.txt"), "line 1\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "init"], directory.path());

    command("git", &["switch", "-c", "feature"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "line 1 feature\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "feature edit"], directory.path());

    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "line 1 main\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "main edit"], directory.path());

    command("git", &["switch", "feature"], directory.path());
    let _ = Command::new("git")
        .args(["rebase", "main"])
        .current_dir(directory.path())
        .output();

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    let status = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status.operation, Some("rebase".into()));
    assert!(status.files.iter().any(|f| f.conflicted));

    let err = vcs::continue_operation(&repository, "rebase", &token)
        .await
        .unwrap_err();
    assert_eq!(err.code, "CONFLICTS_UNRESOLVED");

    let err = vcs::continue_operation(&repository, "cherry-pick", &token)
        .await
        .unwrap_err();
    assert_eq!(err.code, "OPERATION_MISMATCH");

    std::fs::write(directory.path().join("file.txt"), "line 1 resolved\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());

    vcs::continue_operation(&repository, "rebase", &token)
        .await
        .unwrap();

    let status_after = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status_after.operation, None);
    assert!(!status_after.files.iter().any(|f| f.conflicted));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("file.txt")).unwrap(),
        "line 1 resolved\n"
    );
}

#[tokio::test]
async fn real_git_rebase_multi_commit_subsequent_conflict_keeps_rebase_active() {
    if !available("git") {
        eprintln!("SKIP: git not available");
        return;
    }
    let directory = tempdir().unwrap();
    command("git", &["init", "-b", "main"], directory.path());
    command(
        "git",
        &["config", "user.name", "VersionDock Tester"],
        directory.path(),
    );
    command(
        "git",
        &["config", "user.email", "tester@example.com"],
        directory.path(),
    );
    std::fs::write(directory.path().join("file.txt"), "base\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "init"], directory.path());

    command("git", &["switch", "-c", "feature"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "feature 1\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "feature 1"], directory.path());

    std::fs::write(directory.path().join("file.txt"), "feature 2\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "feature 2"], directory.path());

    command("git", &["switch", "main"], directory.path());
    std::fs::write(directory.path().join("file.txt"), "main edit\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());
    command("git", &["commit", "-m", "main edit"], directory.path());

    command("git", &["switch", "feature"], directory.path());
    let _ = Command::new("git")
        .args(["rebase", "main"])
        .current_dir(directory.path())
        .output();

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    let status = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status.operation, Some("rebase".into()));
    assert!(status.files.iter().any(|f| f.conflicted));

    std::fs::write(directory.path().join("file.txt"), "resolved 1\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());

    let continue_err = vcs::continue_operation(&repository, "rebase", &token)
        .await
        .unwrap_err();
    assert!(continue_err.code == "COMMAND_FAILED" || continue_err.code == "CONFLICTS_UNRESOLVED");

    let status_mid = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status_mid.operation, Some("rebase".into()));
    assert!(status_mid.files.iter().any(|f| f.conflicted));

    std::fs::write(directory.path().join("file.txt"), "resolved 2\n").unwrap();
    command("git", &["add", "file.txt"], directory.path());

    vcs::continue_operation(&repository, "rebase", &token)
        .await
        .unwrap();

    let status_done = workspace::git_status(repository.clone(), &token)
        .await
        .unwrap();
    assert_eq!(status_done.operation, None);
    assert!(!status_done.files.iter().any(|f| f.conflicted));
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
    assert_eq!(detail.branches_pending, Some(true));
    assert!(detail.branches.local.is_empty());
    let branches = vcs::commit_branches(&repository, &merge_hash, &token)
        .await
        .unwrap();
    assert!(branches.local.iter().any(|branch| branch == "main"));
    assert_eq!(branches.is_head, Some(true));
    assert!(vcs::commit_branches(&repository, "--help", &token)
        .await
        .is_err());
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
    let tagged_branches = vcs::commit_branches(&repository, &tagged.commit.hash, &token)
        .await
        .unwrap();
    assert!(tagged_branches.tags.iter().any(|tag| tag == "v-detail"));

    // An aggregate including the root must compare against the empty tree,
    // retaining the root's original lines rather than showing only the latest commit.
    let root_range = vcs::diff(
        &repository,
        "base.txt",
        false,
        None,
        Some("4b825dc642cb6eb9a060e54bf8d69288fbee4904".into()),
        Some(merge_hash.clone()),
        &token,
    )
    .await
    .unwrap();
    assert!(root_range.content.contains("+base"));

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
async fn real_svn_commit_detail_without_branch_enrichment() {
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let server = directory.path().join("server");
    let wc = directory.path().join("wc");
    command(
        "svnadmin",
        &["create", server.to_str().unwrap()],
        directory.path(),
    );
    command(
        "svn",
        &["checkout", &svn_file_url(&server), wc.to_str().unwrap()],
        directory.path(),
    );
    std::fs::write(wc.join("app.txt"), "SVN detail\n").unwrap();
    command("svn", &["add", "app.txt"], &wc);
    command("svn", &["commit", "-m", "Initial files"], &wc);
    let repository = repo(&wc, VcsKind::Svn);
    let token = CancellationToken::new();
    let detail = vcs::commit_detail(&repository, "1", &token).await.unwrap();
    assert_eq!(detail.files.len(), 1);
    assert_eq!(detail.files[0].path, "app.txt");
    assert_eq!(detail.branches_pending, None);
    let branches = vcs::commit_branches(&repository, "1", &token)
        .await
        .unwrap();
    assert!(branches.local.is_empty());
}

#[tokio::test]
async fn real_git_commit_detail_rename_and_special_paths_diff() {
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
    std::fs::write(directory.path().join("old name.txt"), "line 1\nline 2\n").unwrap();
    std::fs::write(directory.path().join("中文 原始.txt"), "hello\n").unwrap();
    command(
        "git",
        &["add", "old name.txt", "中文 原始.txt"],
        directory.path(),
    );
    command("git", &["commit", "-m", "initial commit"], directory.path());
    let initial_hash = command_output("git", &["rev-parse", "HEAD"], directory.path());

    command(
        "git",
        &["mv", "old name.txt", "new name.txt"],
        directory.path(),
    );
    std::fs::write(
        directory.path().join("new name.txt"),
        "line 1\nline 2\nline 3\n",
    )
    .unwrap();

    command(
        "git",
        &["mv", "中文 原始.txt", "中文 目标.txt"],
        directory.path(),
    );
    std::fs::write(directory.path().join("中文 目标.txt"), "hello\nworld\n").unwrap();

    command(
        "git",
        &["add", "new name.txt", "中文 目标.txt"],
        directory.path(),
    );
    command(
        "git",
        &["commit", "-m", "rename with modifications"],
        directory.path(),
    );
    let rename_hash = command_output("git", &["rev-parse", "HEAD"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    let detail = vcs::commit_detail(&repository, &rename_hash, &token)
        .await
        .unwrap();

    assert_eq!(
        detail.files.len(),
        2,
        "Expected exactly 2 changed files: {:?}",
        detail.files
    );

    // 关键断言 1：绝不能出现将 old_path 与 new_path 用制表符拼接的错误文件名
    for file in &detail.files {
        assert!(
            !file.path.contains('\t'),
            "File path must not contain tab separator: {:?}",
            file.path
        );
    }

    // 关键断言 2：验证新路径以及 R 状态
    let new_file = detail
        .files
        .iter()
        .find(|f| f.path == "new name.txt")
        .expect("new name.txt must be in commit detail files");
    assert_eq!(new_file.status, "R");
    assert_eq!(new_file.added, Some(1));
    assert_eq!(new_file.removed, Some(0));

    let zh_file = detail
        .files
        .iter()
        .find(|f| f.path == "中文 目标.txt")
        .expect("中文 目标.txt must be in commit detail files");
    assert_eq!(zh_file.status, "R");
    assert_eq!(zh_file.added, Some(1));
    assert_eq!(zh_file.removed, Some(0));

    // 关键断言 3：点击文件打开单提交 diff，必须能正确展示差异和重命名信息
    let single_diff = vcs::diff(
        &repository,
        "new name.txt",
        false,
        Some(rename_hash.clone()),
        None,
        None,
        &token,
    )
    .await
    .unwrap();
    assert!(
        single_diff.content.contains("rename from old name.txt"),
        "Diff should indicate rename source: {}",
        single_diff.content
    );
    assert!(
        single_diff.content.contains("rename to new name.txt"),
        "Diff should indicate rename destination: {}",
        single_diff.content
    );
    assert!(
        single_diff.content.contains("+line 3"),
        "Diff should show added content: {}",
        single_diff.content
    );

    // 关键断言 4：中文重命名文件单提交 diff 成功
    let zh_diff = vcs::diff(
        &repository,
        "中文 目标.txt",
        false,
        Some(rename_hash.clone()),
        None,
        None,
        &token,
    )
    .await
    .unwrap();
    assert!(
        zh_diff.content.contains("+world"),
        "Diff should show added content for chinese file: {}",
        zh_diff.content
    );

    // 关键断言 5：版本范围 diff 成功
    let range_diff = vcs::diff(
        &repository,
        "new name.txt",
        false,
        None,
        Some(initial_hash),
        Some(rename_hash),
        &token,
    )
    .await
    .unwrap();
    assert!(
        range_diff.content.contains("+line 3"),
        "Range diff should show added content: {}",
        range_diff.content
    );
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
    assert!(
        history.commits[0].refs.contains(&"HEAD".to_string()),
        "Latest SVN commit should have HEAD ref: {:?}",
        history.commits[0].refs
    );

    let filtered_history = vcs::history(
        &repository,
        0,
        20,
        HistoryQuery {
            text: Some("initial".into()),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(filtered_history.commits.len(), 1);
    assert_eq!(filtered_history.commits[0].message, "initial svn commit");
    assert!(
        !filtered_history.commits[0]
            .refs
            .contains(&"HEAD".to_string()),
        "Filtered old SVN commit should not be labeled as HEAD: {:?}",
        filtered_history.commits[0].refs
    );

    let path_history = vcs::history(
        &repository,
        0,
        20,
        HistoryQuery {
            path: Some("中文 file.txt".into()),
            text: Some("initial".into()),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(path_history.commits.len(), 1);
    assert!(
        !path_history.commits[0].refs.contains(&"HEAD".to_string()),
        "Path-filtered old commit must not have HEAD ref: {:?}",
        path_history.commits[0].refs
    );

    let topology = vcs::history_topology(&repository, None, 1_000, None, &token)
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
async fn real_svn_trunk_checkout_path_mapping_and_diff() {
    if !available("svn") || !available("svnadmin") {
        eprintln!("SKIP: svn or svnadmin not available");
        return;
    }
    let directory = tempdir().unwrap();
    let repository_path = directory.path().join("svn_repo");
    let checkout = directory.path().join("trunk_checkout");
    command(
        "svnadmin",
        &["create", repository_path.to_str().unwrap()],
        directory.path(),
    );
    let url = svn_file_url(&repository_path);
    command(
        "svn",
        &[
            "mkdir",
            "-m",
            "init layout",
            &format!("{url}/trunk"),
            &format!("{url}/branches"),
        ],
        directory.path(),
    );
    command(
        "svn",
        &[
            "checkout",
            &format!("{url}/trunk"),
            checkout.to_str().unwrap(),
        ],
        directory.path(),
    );
    std::fs::create_dir_all(checkout.join("sub")).unwrap();
    std::fs::write(checkout.join("sub/example.txt"), "hello trunk\n").unwrap();
    let repository = repo(&checkout, VcsKind::Svn);
    let token = CancellationToken::new();

    let status = workspace::svn_status(repository.clone(), &token)
        .await
        .unwrap();
    assert!(status
        .files
        .iter()
        .any(|f| f.path == "sub/example.txt" && f.status == "untracked"));

    vcs::commit(
        &repository,
        "add example in trunk",
        false,
        &["sub/example.txt".into()],
        &token,
    )
    .await
    .unwrap();

    let history = vcs::history(&repository, 0, 10, Default::default(), &token)
        .await
        .unwrap();
    let first_rev = history
        .commits
        .iter()
        .find(|c| c.message == "add example in trunk")
        .map(|c| c.hash.clone())
        .expect("first commit found");

    let detail = vcs::commit_detail(&repository, &first_rev, &token)
        .await
        .unwrap();
    assert_eq!(detail.commit.message, "add example in trunk");
    // 关键断言：文件树不能显示 trunk/sub/example.txt，而必须映射为相对于工作副本的 sub/example.txt
    assert_eq!(
        detail.files.len(),
        1,
        "Directory paths must be filtered out and only file returned: {:?}",
        detail.files
    );
    assert_eq!(
        detail.files[0].path, "sub/example.txt",
        "Path must be mapped to working copy root, not repository root"
    );

    // 修改并提交第二版
    std::fs::write(checkout.join("sub/example.txt"), "hello trunk\nline 2\n").unwrap();
    vcs::commit(
        &repository,
        "update example in trunk",
        false,
        &["sub/example.txt".into()],
        &token,
    )
    .await
    .unwrap();

    let history2 = vcs::history(&repository, 0, 10, Default::default(), &token)
        .await
        .unwrap();
    let second_rev = history2
        .commits
        .iter()
        .find(|c| c.message == "update example in trunk")
        .map(|c| c.hash.clone())
        .expect("second commit found");

    // 单版本 diff 针对工作副本相对路径
    let single_diff = vcs::diff(
        &repository,
        "sub/example.txt",
        false,
        Some(second_rev.clone()),
        None,
        None,
        &token,
    )
    .await
    .unwrap();
    assert!(
        single_diff.content.contains("+line 2"),
        "Single commit diff should contain added line: {}",
        single_diff.content
    );

    // 范围 diff
    let range_diff = vcs::diff(
        &repository,
        "sub/example.txt",
        false,
        None,
        Some(first_rev),
        Some(second_rev),
        &token,
    )
    .await
    .unwrap();
    assert!(
        range_diff.content.contains("+line 2"),
        "Range diff should contain added line: {}",
        range_diff.content
    );
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

#[tokio::test]
async fn real_git_unpushed_operations_reject_already_pushed_commits_and_stale_undo_head() {
    let remote_dir = tempfile::tempdir().unwrap();
    command("git", &["init", "--bare"], remote_dir.path());

    let work_dir = tempfile::tempdir().unwrap();
    command(
        "git",
        &["clone", remote_dir.path().to_str().unwrap(), "."],
        work_dir.path(),
    );
    command("git", &["checkout", "-b", "main"], work_dir.path());
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        work_dir.path(),
    );
    command(
        "git",
        &["config", "user.email", "versiondock@example.test"],
        work_dir.path(),
    );
    std::fs::write(work_dir.path().join("base.txt"), "base\n").unwrap();
    command("git", &["add", "."], work_dir.path());
    command("git", &["commit", "-m", "base"], work_dir.path());
    command("git", &["push", "-u", "origin", "main"], work_dir.path());

    let repository = repo(work_dir.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // 1. Commit 1 locally (unpushed)
    std::fs::write(work_dir.path().join("c1.txt"), "c1\n").unwrap();
    command("git", &["add", "."], work_dir.path());
    command("git", &["commit", "-m", "commit 1"], work_dir.path());
    let c1 = command_output("git", &["rev-parse", "HEAD"], work_dir.path());

    // 2. UndoHead with stale/wrong expected_hash must fail
    let err_stale = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::UndoHead {
            expected_hash: Some("0000000000000000000000000000000000000000".into()),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_stale.code, "COMMIT_NOT_HEAD");

    // 3. Push commit 1 to origin
    command("git", &["push"], work_dir.path());

    // 4. UndoHead on already-pushed commit must fail
    let err_pushed_undo = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::UndoHead {
            expected_hash: Some(c1.clone()),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_pushed_undo.code, "COMMIT_ALREADY_PUSHED");

    // 5. EditMessage on already-pushed commit must fail
    let err_pushed_edit = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::EditMessage {
            hash: c1.clone(),
            message: "edited c1".into(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_pushed_edit.code, "COMMIT_ALREADY_PUSHED");

    // 6. Drop on already-pushed commit must fail
    let err_pushed_drop = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::Drop {
            hashes: vec![c1.clone()],
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_pushed_drop.code, "COMMIT_ALREADY_PUSHED");

    // 7. Make two new commits: c2, c3
    std::fs::write(work_dir.path().join("c2.txt"), "c2\n").unwrap();
    command("git", &["add", "."], work_dir.path());
    command("git", &["commit", "-m", "commit 2"], work_dir.path());
    let c2 = command_output("git", &["rev-parse", "HEAD"], work_dir.path());

    std::fs::write(work_dir.path().join("c3.txt"), "c3\n").unwrap();
    command("git", &["add", "."], work_dir.path());
    command("git", &["commit", "-m", "commit 3"], work_dir.path());
    let c3 = command_output("git", &["rev-parse", "HEAD"], work_dir.path());

    // 8. Squash contiguous range that includes pushed c1 (c3, c2, c1) must fail
    let err_pushed_squash = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::Squash {
            hashes: vec![c3.clone(), c2.clone(), c1.clone()],
            message: "squashed all".into(),
        },
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_pushed_squash.code, "COMMIT_ALREADY_PUSHED");

    // 9. UndoHead on truly unpushed c3 with correct expected_hash must succeed
    vcs::unpushed_operation(
        &repository,
        UnpushedOperation::UndoHead {
            expected_hash: Some(c3.clone()),
        },
        &token,
    )
    .await
    .unwrap();

    let new_head = command_output("git", &["rev-parse", "HEAD"], work_dir.path());
    assert_eq!(new_head, c2);
}

#[tokio::test]
async fn real_git_history_reset_rejects_stale_branch_and_stale_head() {
    let directory = tempfile::tempdir().unwrap();
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

    // Create feature branch
    command("git", &["checkout", "-b", "feature"], directory.path());
    std::fs::write(directory.path().join("f1.txt"), "f1\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "feature 1"], directory.path());
    let f1 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    std::fs::write(directory.path().join("f2.txt"), "f2\n").unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "feature 2"], directory.path());
    let f2 = command_output("git", &["rev-parse", "HEAD"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // 1. Reset with wrong expected_branch must fail
    let err_branch = vcs::history_operation(
        &repository,
        HistoryOperation::Reset {
            revision: f1.clone(),
            mode: "hard".into(),
            expected_branch: Some("main".into()),
            expected_head: Some(f2.clone()),
        },
        false,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_branch.code, "BRANCH_CHANGED");

    // 2. Reset with stale expected_head must fail
    let err_head = vcs::history_operation(
        &repository,
        HistoryOperation::Reset {
            revision: f1.clone(),
            mode: "hard".into(),
            expected_branch: Some("feature".into()),
            expected_head: Some(f1.clone()), // Stale: actual HEAD is f2
        },
        false,
        &token,
    )
    .await
    .unwrap_err();
    assert_eq!(err_head.code, "HEAD_CHANGED");

    // 3. Reset with matching branch and HEAD must succeed
    vcs::history_operation(
        &repository,
        HistoryOperation::Reset {
            revision: f1.clone(),
            mode: "hard".into(),
            expected_branch: Some("feature".into()),
            expected_head: Some(f2.clone()),
        },
        false,
        &token,
    )
    .await
    .unwrap();

    let current_head = command_output("git", &["rev-parse", "HEAD"], directory.path());
    assert_eq!(current_head, f1);
    assert!(!directory.path().join("f2.txt").exists());
}

#[tokio::test]
async fn real_git_history_with_line_range_on_lines_beyond_file_length_returns_empty() {
    let directory = tempfile::tempdir().unwrap();
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
    std::fs::write(
        directory.path().join("short.txt"),
        "line 1\nline 2\nline 3\n",
    )
    .unwrap();
    command("git", &["add", "."], directory.path());
    command("git", &["commit", "-m", "short file"], directory.path());

    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // Query lines 50..60 on a 3-line file
    let page = vcs::history(
        &repository,
        0,
        10,
        HistoryQuery {
            path: Some("short.txt".into()),
            line_range: Some(crate::models::LineRange { start: 50, end: 60 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();

    assert!(page.commits.is_empty());
    assert!(!page.has_more);
}

#[tokio::test]
async fn real_git_unpushed_operations_reject_concurrent_push_from_other_clone() {
    let remote_dir = tempfile::tempdir().unwrap();
    command("git", &["init", "--bare"], remote_dir.path());

    // Clone 1 setup
    let clone1_dir = tempfile::tempdir().unwrap();
    command(
        "git",
        &["clone", remote_dir.path().to_str().unwrap(), "."],
        clone1_dir.path(),
    );
    command("git", &["checkout", "-b", "main"], clone1_dir.path());
    command(
        "git",
        &["config", "user.name", "Clone 1"],
        clone1_dir.path(),
    );
    command(
        "git",
        &["config", "user.email", "clone1@example.test"],
        clone1_dir.path(),
    );
    std::fs::write(clone1_dir.path().join("base.txt"), "base\n").unwrap();
    command("git", &["add", "."], clone1_dir.path());
    command("git", &["commit", "-m", "base"], clone1_dir.path());
    command("git", &["push", "-u", "origin", "main"], clone1_dir.path());

    let base_hash = command_output("git", &["rev-parse", "HEAD"], clone1_dir.path());

    // Clone 2 setup
    let clone2_dir = tempfile::tempdir().unwrap();
    command(
        "git",
        &["clone", remote_dir.path().to_str().unwrap(), "."],
        clone2_dir.path(),
    );
    command("git", &["checkout", "main"], clone2_dir.path());
    command(
        "git",
        &["config", "user.name", "Clone 2"],
        clone2_dir.path(),
    );
    command(
        "git",
        &["config", "user.email", "clone2@example.test"],
        clone2_dir.path(),
    );

    // Clone 1 creates commit A and pushes it to origin
    std::fs::write(clone1_dir.path().join("a.txt"), "a\n").unwrap();
    command("git", &["add", "."], clone1_dir.path());
    command("git", &["commit", "-m", "commit A"], clone1_dir.path());
    command("git", &["push", "origin", "main"], clone1_dir.path());
    let commit_a = command_output("git", &["rev-parse", "HEAD"], clone1_dir.path());

    // Clone 2 fetches the commit object and resets to commit A,
    // but without updating origin/main tracking branch yet
    command("git", &["fetch", "origin", &commit_a], clone2_dir.path());
    command("git", &["reset", "--hard", &commit_a], clone2_dir.path());

    // Verify clone 2 local tracking ref is still base before operation
    let stale_upstream = command_output("git", &["rev-parse", "origin/main"], clone2_dir.path());
    assert_eq!(stale_upstream, base_hash);

    let repository2 = repo(clone2_dir.path(), VcsKind::Git);
    let token = CancellationToken::new();

    // Clone 2 tries to undo commit A, which was pushed by Clone 1
    let err = vcs::unpushed_operation(
        &repository2,
        UnpushedOperation::UndoHead {
            expected_hash: Some(commit_a.clone()),
        },
        &token,
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, "COMMIT_ALREADY_PUSHED");

    // After unpushed_operation, clone 2's remote tracking ref should have been refreshed to commit A
    let refreshed_upstream =
        command_output("git", &["rev-parse", "origin/main"], clone2_dir.path());
    assert_eq!(refreshed_upstream, commit_a);
}

#[tokio::test]
async fn real_git_unpushed_operations_reject_when_remote_unreachable() {
    let directory = tempfile::tempdir().unwrap();
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

    // Add an unreachable remote
    command(
        "git",
        &[
            "remote",
            "add",
            "origin",
            "file:///non/existent/path/for/versiondock/test.git",
        ],
        directory.path(),
    );

    let head = command_output("git", &["rev-parse", "HEAD"], directory.path());
    let repository = repo(directory.path(), VcsKind::Git);
    let token = CancellationToken::new();

    let err = vcs::unpushed_operation(
        &repository,
        UnpushedOperation::UndoHead {
            expected_hash: Some(head),
        },
        &token,
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, "CANNOT_VERIFY_REMOTE_STATE");
    assert!(err
        .message
        .contains("Cannot verify remote tracking state for 'origin'"));
}

#[tokio::test]
async fn notification_skip_cherry_pick_uses_real_git_and_checks_active_operation() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    command("git", &["init", "-b", "main"], root.path());
    command("git", &["config", "user.name", "Test"], root.path());
    command(
        "git",
        &["config", "user.email", "test@example.test"],
        root.path(),
    );
    std::fs::write(root.path().join("file.txt"), "base\n").unwrap();
    command("git", &["add", "."], root.path());
    command("git", &["commit", "-m", "base"], root.path());
    command("git", &["switch", "-c", "feature"], root.path());
    std::fs::write(root.path().join("file.txt"), "feature\n").unwrap();
    command("git", &["commit", "-am", "feature"], root.path());
    command("git", &["switch", "main"], root.path());
    std::fs::write(root.path().join("file.txt"), "main\n").unwrap();
    command("git", &["commit", "-am", "main"], root.path());
    let repository = repo(root.path(), VcsKind::Git);
    let token = CancellationToken::new();
    assert!(vcs::skip_operation(&repository, "cherry-pick", &token)
        .await
        .is_err());
    let conflict = Command::new("git")
        .args(["cherry-pick", "feature"])
        .current_dir(root.path())
        .output()
        .unwrap();
    assert!(!conflict.status.success());
    assert!(vcs::skip_operation(&repository, "rebase", &token)
        .await
        .is_err());
    vcs::skip_operation(&repository, "cherry-pick", &token)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "main\n"
    );
    assert!(!root.path().join(".git/CHERRY_PICK_HEAD").exists());
}

#[tokio::test]
async fn notification_unlock_resolves_git_and_worktree_metadata_without_deleting_other_files() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    command("git", &["init", "-b", "main"], root.path());
    command("git", &["config", "user.name", "Test"], root.path());
    command(
        "git",
        &["config", "user.email", "test@example.test"],
        root.path(),
    );
    command(
        "git",
        &["commit", "--allow-empty", "-m", "base"],
        root.path(),
    );
    let lock = root.path().join(".git/index.lock");
    let other = root.path().join("index.lock");
    std::fs::write(&lock, "").unwrap();
    std::fs::write(&other, "keep").unwrap();
    crate::cli::unlock_git_index(root.path()).unwrap();
    assert!(!lock.exists());
    assert!(other.exists());
    crate::cli::unlock_git_index(root.path()).unwrap();
    let worktree = root.path().join("worktree");
    command(
        "git",
        &[
            "worktree",
            "add",
            "-b",
            "feature",
            worktree.to_str().unwrap(),
        ],
        root.path(),
    );
    let metadata = std::fs::read_to_string(worktree.join(".git")).unwrap();
    let gitdir = Path::new(metadata.trim().strip_prefix("gitdir: ").unwrap());
    std::fs::write(gitdir.join("index.lock"), "").unwrap();
    crate::cli::unlock_git_index(&worktree).unwrap();
    assert!(!gitdir.join("index.lock").exists());
    assert!(other.exists());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&other, &lock).unwrap();
        assert!(crate::cli::unlock_git_index(root.path()).is_err());
        assert!(other.exists());
    }
}

#[tokio::test]
async fn real_git_sidebar_branch_names_and_checkout_survive_tag_namespace_collisions() {
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    let path = directory.path();
    command("git", &["init", "-b", "main"], path);
    command("git", &["config", "user.name", "Sidebar Test"], path);
    command(
        "git",
        &["config", "user.email", "sidebar@example.test"],
        path,
    );
    std::fs::write(path.join("file.txt"), "base\n").unwrap();
    command("git", &["add", "."], path);
    command("git", &["commit", "-m", "base"], path);
    command("git", &["tag", "main"], path);
    command("git", &["branch", "topic", "refs/heads/main"], path);
    command(
        "git",
        &["remote", "add", "origin", path.to_str().unwrap()],
        path,
    );
    command("git", &["fetch", "origin"], path);
    command("git", &["tag", "origin/topic"], path);
    command("git", &["branch", "-D", "topic"], path);
    let repository = repo(path, VcsKind::Git);
    let token = CancellationToken::new();
    let branches = vcs::branches(&repository, &token).await.unwrap();
    for branch in &branches {
        let date = branch
            .last_commit_date
            .as_deref()
            .expect("branch commit timestamp");
        assert!(
            chrono::DateTime::parse_from_rfc3339(date).is_ok(),
            "expected locale-independent timestamp, got {date}"
        );
    }
    assert!(branches
        .iter()
        .any(|branch| branch.name == "main" && branch.current && !branch.remote));
    assert!(branches.iter().any(|branch| branch.name == "origin/topic"
        && branch.remote
        && branch.remote_name.as_deref() == Some("origin")));
    assert!(!branches
        .iter()
        .any(|branch| branch.name.starts_with("heads/") || branch.name.starts_with("remotes/")));
    vcs::branch_operation(
        &repository,
        BranchOperation::Checkout {
            name: "origin/topic".into(),
        },
        &token,
    )
    .await
    .unwrap();
    assert_eq!(
        command_output("git", &["branch", "--show-current"], path),
        "topic"
    );
    assert_eq!(
        command_output(
            "git",
            &["rev-parse", "--symbolic-full-name", "@{upstream}"],
            path
        ),
        "refs/remotes/origin/topic"
    );
    vcs::tag_operation(
        &repository,
        TagOperation::Checkout {
            name: "main".into(),
        },
        &token,
    )
    .await
    .unwrap();
    let head = vcs::branches(&repository, &token)
        .await
        .unwrap()
        .into_iter()
        .find(|branch| branch.current)
        .unwrap();
    assert_eq!(head.name, "HEAD");
    assert!(head.detached_tag.is_some());
}

#[tokio::test]
async fn real_git_diff_rename_counts_and_mutable_line_history() {
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    let path = directory.path();
    command("git", &["init", "-b", "main"], path);
    command("git", &["config", "user.name", "Diff QA"], path);
    command("git", &["config", "user.email", "diff@example.test"], path);
    let original = (1..=80)
        .map(|line| format!("line {line:03} original\n"))
        .collect::<String>();
    std::fs::write(path.join("demo.txt"), &original).unwrap();
    std::fs::write(path.join("old-name.txt"), "same content\n").unwrap();
    command("git", &["add", "."], path);
    command("git", &["commit", "-m", "Initial"], path);
    let head = command_output("git", &["rev-parse", "HEAD"], path);
    let index = format!("staged one\nstaged two\n{original}");
    std::fs::write(path.join("demo.txt"), &index).unwrap();
    command("git", &["add", "demo.txt"], path);
    command("git", &["mv", "old-name.txt", "new-name.txt"], path);
    std::fs::write(
        path.join("demo.txt"),
        index.replace("line 005 original", "line 005 changed"),
    )
    .unwrap();
    let repository = repo(path, VcsKind::Git);
    let token = CancellationToken::new();
    let working = vcs::diff(&repository, "demo.txt", false, None, None, None, &token)
        .await
        .unwrap();
    assert_eq!(working.line_count, 82);
    let renamed = vcs::diff(&repository, "new-name.txt", true, None, None, None, &token)
        .await
        .unwrap();
    assert!(renamed.content.contains("rename from old-name.txt"));
    assert!(renamed.content.contains("rename to new-name.txt"));
    assert!(!renamed.content.contains("+same content"));
    assert_eq!(renamed.line_count, 1);
    let range = crate::models::LineRange { start: 4, end: 6 };
    for source in ["INDEX", "WORKTREE"] {
        let target = vcs::diff_line_history_target(&repository, "demo.txt", source, range, &token)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.revision, head);
        assert_eq!(target.path, "demo.txt");
        assert_eq!(
            target.line_range,
            crate::models::LineRange { start: 2, end: 4 }
        );
    }
    assert!(vcs::diff_line_history_target(
        &repository,
        "demo.txt",
        "INDEX",
        crate::models::LineRange { start: 1, end: 2 },
        &token
    )
    .await
    .unwrap()
    .is_none());
    let renamed_history = vcs::diff_line_history_target(
        &repository,
        "new-name.txt",
        "INDEX",
        crate::models::LineRange { start: 1, end: 1 },
        &token,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(renamed_history.path, "old-name.txt");
    // History at the mapped coordinates works on the real commit.
    let result = vcs::history(
        &repository,
        0,
        100,
        HistoryQuery {
            path: Some("demo.txt".into()),
            revision: Some(head),
            line_range: Some(crate::models::LineRange { start: 2, end: 4 }),
            ..Default::default()
        },
        &token,
    )
    .await
    .unwrap();
    assert!(!result.commits.is_empty());
    assert_eq!(
        command_output("git", &["show", ":demo.txt"], path),
        index.trim_end()
    );
    assert!(
        vcs::diff_line_history_target(&repository, "../escape", "INDEX", range, &token)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn real_svn_diff_full_context_properties_and_history_mapping() {
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let store = directory.path().join("store");
    let wc = directory.path().join("wc");
    command(
        "svnadmin",
        &["create", store.to_str().unwrap()],
        directory.path(),
    );
    let url = format!("file://{}", store.display());
    command(
        "svn",
        &["checkout", &url, wc.to_str().unwrap()],
        directory.path(),
    );
    let original = (1..=80)
        .map(|line| format!("line {line:03} original\n"))
        .collect::<String>();
    std::fs::write(wc.join("demo.txt"), &original).unwrap();
    command("svn", &["add", "demo.txt"], &wc);
    command("svn", &["commit", "-m", "Initial"], &wc);
    let changed = format!(
        "working insertion\n{}",
        original
            .replace("line 005 original", "line 005 changed")
            .replace("line 065 original", "line 065 changed")
    );
    std::fs::write(wc.join("demo.txt"), &changed).unwrap();
    command("svn", &["propset", "svn:keywords", "Id", "demo.txt"], &wc);
    let repository = repo(&wc, VcsKind::Svn);
    let token = CancellationToken::new();
    let document = vcs::diff(&repository, "demo.txt", false, None, None, None, &token)
        .await
        .unwrap();
    assert!(document.content.contains("line 040 original"));
    assert!(document.content.contains("line 080 original"));
    assert!(document.content.contains("Added: svn:keywords"));
    assert_eq!(document.line_count, 81);
    let target = vcs::diff_line_history_target(
        &repository,
        "demo.txt",
        "WORKING",
        crate::models::LineRange { start: 3, end: 5 },
        &token,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(target.revision, "1");
    assert_eq!(
        target.line_range,
        crate::models::LineRange { start: 2, end: 4 }
    );
    assert!(vcs::diff_line_history_target(
        &repository,
        "demo.txt",
        "WORKING",
        crate::models::LineRange { start: 1, end: 1 },
        &token
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(
        std::fs::read_to_string(wc.join("demo.txt")).unwrap(),
        changed
    );
}

#[tokio::test]
async fn real_git_file_history_preserves_special_filenames() {
    if !available("git") {
        return;
    }
    let directory = tempdir().unwrap();
    let root = directory.path();
    command("git", &["init", "-b", "main"], root);
    command("git", &["config", "user.name", "History QA"], root);
    command(
        "git",
        &["config", "user.email", "history@example.test"],
        root,
    );
    let names = if cfg!(windows) {
        vec!["space file.txt", "中文文件.txt", "literal[1].txt"]
    } else {
        vec![
            "tab\tfile.txt",
            "quote\" file.txt",
            "back\\slash.txt",
            "[literal]*.txt",
            "newline\nfile.txt",
            "record\u{1e}file.txt",
        ]
    };
    for (index, name) in names.iter().enumerate() {
        std::fs::write(root.join(name), format!("unique initial {index}\n")).unwrap();
    }
    command("git", &["add", "."], root);
    command("git", &["commit", "-m", "initial"], root);
    for (index, name) in names.iter().enumerate() {
        std::fs::write(
            root.join(name),
            format!("unique initial {index}\nmodified {index}\n"),
        )
        .unwrap();
    }
    command("git", &["add", "."], root);
    command("git", &["commit", "-m", "modify"], root);
    let repository = repo(root, VcsKind::Git);
    let token = CancellationToken::new();
    for (index, name) in names.iter().enumerate() {
        let page = vcs::file_history(&repository, name, None, 1, &token)
            .await
            .unwrap();
        assert_eq!(page.entries[0].path, *name);
        let source = vcs::file_revision_content(
            &repository,
            &page.entries[0].path,
            &page.entries[0].revision,
            crate::models::CatFileFilterMode::None,
            &token,
        )
        .await
        .unwrap();
        assert!(source.content.contains(&format!("modified {index}")));
        let old = vcs::file_history(&repository, name, page.next_cursor.as_deref(), 1, &token)
            .await
            .unwrap();
        assert_eq!(old.entries[0].path, *name);
        assert!(old.entries[0].previous_revision.is_none());
    }
}

#[tokio::test]
async fn real_svn_file_history_tracks_renames_directory_copies_and_target_status() {
    if !available("svn") || !available("svnadmin") {
        return;
    }
    let directory = tempdir().unwrap();
    let store = directory.path().join("store");
    let wc = directory.path().join("wc");
    command(
        "svnadmin",
        &["create", store.to_str().unwrap()],
        directory.path(),
    );
    let url = svn_file_url(&store);
    command(
        "svn",
        &["checkout", &url, wc.to_str().unwrap()],
        directory.path(),
    );
    command("svn", &["mkdir", "trunk", "branches"], &wc);
    command("svn", &["commit", "-m", "structure"], &wc);
    let trunk = wc.join("trunk");
    let special = if cfg!(windows) {
        "percent%20@.txt"
    } else {
        "percent%20@?.txt"
    };
    std::fs::write(trunk.join(special), "special SVN source\n").unwrap();
    std::fs::write(trunk.join("old-name.txt"), "one\ntwo\n").unwrap();
    std::fs::write(trunk.join("z.txt"), "original z\n").unwrap();
    command("svn", &["add", "old-name.txt", "z.txt"], &trunk);
    command("svn", &["add", &format!("{special}@")], &trunk);
    command("svn", &["commit", "-m", "initial files"], &trunk);
    std::fs::write(trunk.join("old-name.txt"), "one\ntwo updated\n").unwrap();
    command("svn", &["commit", "-m", "edit old path"], &trunk);
    command("svn", &["move", "old-name.txt", "new-name.txt"], &trunk);
    command("svn", &["commit", "-m", "rename file"], &trunk);
    std::fs::write(trunk.join("a.txt"), "new a\n").unwrap();
    std::fs::write(trunk.join("z.txt"), "modified z\n").unwrap();
    command("svn", &["add", "a.txt"], &trunk);
    command("svn", &["commit", "-m", "add a and modify z"], &trunk);
    command("svn", &["update"], &wc);
    command("svn", &["copy", "trunk", "branches/copied"], &wc);
    command("svn", &["commit", "-m", "copy directory"], &wc);
    command("svn", &["update"], &wc);
    let token = CancellationToken::new();
    let repository = repo(&trunk, VcsKind::Svn);
    let page = vcs::file_history(&repository, "new-name.txt", None, 1, &token)
        .await
        .unwrap();
    assert_eq!(page.entries[0].status, "R");
    assert_eq!(
        page.entries[0].previous_path.as_deref(),
        Some("old-name.txt")
    );
    let old = vcs::file_history(
        &repository,
        "new-name.txt",
        page.next_cursor.as_deref(),
        100,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(old.entries[0].path, "old-name.txt");
    let content = vcs::file_revision_content(
        &repository,
        &old.entries[0].path,
        &old.entries[0].revision,
        crate::models::CatFileFilterMode::None,
        &token,
    )
    .await
    .unwrap();
    assert!(content.content.contains("two updated"));
    let diff = vcs::diff(
        &repository,
        &old.entries[0].path,
        false,
        None,
        old.entries[0].previous_revision.clone(),
        Some(old.entries[0].revision.clone()),
        &token,
    )
    .await
    .unwrap();
    assert!(diff.content.contains("+two updated"));
    let special_history = vcs::file_history(&repository, special, None, 100, &token)
        .await
        .unwrap();
    let special_source = vcs::file_revision_content(
        &repository,
        special,
        &special_history.entries[0].revision,
        crate::models::CatFileFilterMode::None,
        &token,
    )
    .await
    .unwrap();
    assert_eq!(special_source.content, "special SVN source\n");
    let z = vcs::file_history(&repository, "z.txt", None, 100, &token)
        .await
        .unwrap();
    assert_eq!(z.entries[0].status, "M");
    let copied = repo(&wc.join("branches/copied"), VcsKind::Svn);
    let page = vcs::file_history(&copied, "new-name.txt", None, 100, &token)
        .await
        .unwrap();
    assert_eq!(
        page.entries[0].previous_path.as_deref(),
        Some("^/trunk/new-name.txt")
    );
    assert_eq!(page.entries[0].status, "C");
    let old = page
        .entries
        .iter()
        .find(|entry| entry.message == "edit old path")
        .unwrap();
    assert_eq!(old.path, "^/trunk/old-name.txt");
    let content = vcs::file_revision_content(
        &copied,
        &old.path,
        &old.revision,
        crate::models::CatFileFilterMode::None,
        &token,
    )
    .await
    .unwrap();
    assert!(content.content.contains("two updated"));
}

fn update_parity_fixture(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let remote = root.join("remote.git");
    let working = root.join("working");
    command("git", &["init", "--bare", remote.to_str().unwrap()], root);
    command(
        "git",
        &["init", "-b", "main", working.to_str().unwrap()],
        root,
    );
    command(
        "git",
        &["config", "user.name", "VersionDock Test"],
        &working,
    );
    command(
        "git",
        &["config", "user.email", "test@example.test"],
        &working,
    );
    std::fs::write(working.join("local.txt"), "base\n").unwrap();
    command("git", &["add", "."], &working);
    command("git", &["commit", "-m", "base"], &working);
    command(
        "git",
        &["remote", "add", "origin", remote.to_str().unwrap()],
        &working,
    );
    command("git", &["push", "-u", "origin", "main"], &working);
    (remote, working)
}

#[tokio::test]
async fn real_git_project_stash_matches_plugin_pop_semantics() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    std::fs::write(working.join("local.txt"), "staged\n").unwrap();
    command("git", &["add", "local.txt"], &working);
    std::fs::write(working.join("local.txt"), "unstaged\n").unwrap();
    std::fs::write(working.join("new.txt"), "untracked\n").unwrap();
    vcs::sync_with_worktree_backup(
        root.path(),
        &repo(&working, VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &crate::models::DesktopSettings {
            update_project_clean_working_tree: crate::models::CleanWorkingTreeMethod::Stash,
            ..Default::default()
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(read_text(working.join("local.txt")), "unstaged\n");
    assert_eq!(read_text(working.join("new.txt")), "untracked\n");
    assert!(command_output("git", &["diff", "--cached"], &working).is_empty());
    assert!(command_output("git", &["status", "--porcelain"], &working).contains("?? new.txt"));
    assert!(command_output("git", &["stash", "list"], &working).is_empty());
}

#[tokio::test]
async fn real_git_update_shelf_does_not_resurrect_newly_staged_deleted_files() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    std::fs::write(working.join("local.txt"), "local edits\n").unwrap();
    std::fs::write(working.join("withdrawn.txt"), "withdrawn feature\n").unwrap();
    command("git", &["add", "withdrawn.txt"], &working);
    std::fs::remove_file(working.join("withdrawn.txt")).unwrap();
    std::fs::write(working.join("new.txt"), "untracked\n").unwrap();
    vcs::sync_with_worktree_backup(
        root.path(),
        &repo(&working, VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &Default::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(read_text(working.join("local.txt")), "local edits\n");
    assert_eq!(read_text(working.join("new.txt")), "untracked\n");
    assert!(!working.join("withdrawn.txt").exists());
    assert!(command_output("git", &["stash", "list"], &working).is_empty());
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "parent subprocess entry for detached update tests"]
async fn detached_update_parent() {
    let root =
        std::path::PathBuf::from(std::env::var_os("VERSIONDOCK_DETACHED_TEST_ROOT").unwrap());
    let request: crate::update_worker::UpdateRequest =
        serde_json::from_slice(&std::fs::read(root.join("worker-request.json")).unwrap()).unwrap();
    let (child, directory) = crate::update_worker::launch(
        &std::env::current_exe().unwrap(),
        &request,
        &[
            "--ignored",
            "--exact",
            "update_worker::tests::worker_entry",
            "--nocapture",
        ],
    )
    .unwrap();
    std::fs::write(
        root.join("worker-directory"),
        directory.to_string_lossy().as_bytes(),
    )
    .unwrap();
    crate::update_worker::wait(child, directory, &CancellationToken::new())
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn real_git_detached_update_restores_after_parent_is_killed_and_supports_cancel() {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    if !available("git") {
        return;
    }
    for method in [
        crate::models::CleanWorkingTreeMethod::Shelve,
        crate::models::CleanWorkingTreeMethod::Stash,
    ] {
        for cancel in [false, true] {
            let root = tempdir().unwrap();
            let (remote, working) = update_parity_fixture(root.path());
            let seed = root.path().join("seed");
            command(
                "git",
                &[
                    "clone",
                    "-b",
                    "main",
                    remote.to_str().unwrap(),
                    seed.to_str().unwrap(),
                ],
                root.path(),
            );
            command("git", &["config", "user.name", "VersionDock Test"], &seed);
            command("git", &["config", "user.email", "test@example.test"], &seed);
            std::fs::write(seed.join("upstream.txt"), "upstream change\n").unwrap();
            command("git", &["add", "."], &seed);
            command("git", &["commit", "-m", "upstream"], &seed);
            command("git", &["push"], &seed);
            std::fs::write(working.join("local.txt"), "staged\n").unwrap();
            command("git", &["add", "local.txt"], &working);
            std::fs::write(working.join("local.txt"), "unstaged\n").unwrap();
            std::fs::write(working.join("new.txt"), "untracked\n").unwrap();
            std::fs::write(working.join("new.bin"), [0, 255, 17, 99]).unwrap();
            let marker = root.path().join("transport-started");
            let release = root.path().join("transport-release");
            let transport = root.path().join("gated-upload-pack");
            std::fs::write(&transport, format!("#!/bin/sh\ntouch '{}'\nwhile [ ! -f '{}' ]; do sleep 0.05; done\nexec git-upload-pack \"$@\"\n", marker.display(), release.display())).unwrap();
            std::fs::set_permissions(&transport, std::fs::Permissions::from_mode(0o755)).unwrap();
            command(
                "git",
                &[
                    "config",
                    "remote.origin.uploadpack",
                    transport.to_str().unwrap(),
                ],
                &working,
            );
            let request = crate::update_worker::UpdateRequest {
                log_context: None,
                config_dir: root.path().join("config"),
                repo: repo(&working, VcsKind::Git),
                action: SyncAction::Pull,
                remote: None,
                branch: None,
                force: false,
                settings: crate::models::DesktopSettings {
                    update_project_clean_working_tree: method.clone(),
                    ..Default::default()
                },
            };
            std::fs::write(
                root.path().join("worker-request.json"),
                serde_json::to_vec(&request).unwrap(),
            )
            .unwrap();
            let mut parent = if cancel {
                None
            } else {
                Some(
                    Command::new(std::env::current_exe().unwrap())
                        .args([
                            "--ignored",
                            "--exact",
                            "integration_tests::detached_update_parent",
                            "--nocapture",
                        ])
                        .env("VERSIONDOCK_DETACHED_TEST_ROOT", root.path())
                        .process_group(0)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .unwrap(),
                )
            };
            let launched = if cancel {
                Some(
                    crate::update_worker::launch(
                        &std::env::current_exe().unwrap(),
                        &request,
                        &[
                            "--ignored",
                            "--exact",
                            "update_worker::tests::worker_entry",
                            "--nocapture",
                        ],
                    )
                    .unwrap(),
                )
            } else {
                None
            };
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                while !marker.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("worker must capture local changes and start the real Git transport");
            assert!(!working.join("new.txt").exists());
            // A restarted app must queue further writes until the independent recovery completes.
            let queued_cancel = CancellationToken::new();
            let waiting = crate::update_worker::repository_lock(
                &request.config_dir,
                &request.repo.id,
                &queued_cancel,
            );
            tokio::pin!(waiting);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), &mut waiting)
                    .await
                    .is_err()
            );
            queued_cancel.cancel();
            assert_eq!(waiting.await.unwrap_err().code, "REQUEST_CANCELLED");
            if let Some((child, directory)) = launched {
                let token = CancellationToken::new();
                token.cancel();
                let error = tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    crate::update_worker::wait(child, directory, &token),
                )
                .await
                .unwrap()
                .unwrap_err();
                assert_eq!(error.code, "REQUEST_CANCELLED");
                assert!(!working.join("upstream.txt").exists());
                if method == crate::models::CleanWorkingTreeMethod::Stash {
                    assert!(
                        command_output("git", &["diff", "--cached"], &working).contains("+staged")
                    );
                }
            } else {
                // Kill the whole UI process group, as a source watcher can do,
                // rather than merely dropping one Rust task or one pipe.
                let parent_group = parent.as_ref().unwrap().id() as i32;
                assert_eq!(unsafe { libc::kill(-parent_group, libc::SIGKILL) }, 0);
                parent.as_mut().unwrap().wait().unwrap();
                std::fs::write(&release, "continue").unwrap();
                tokio::time::timeout(std::time::Duration::from_secs(15), async {
                    loop {
                        if working.join("new.txt").exists()
                            && working.join("upstream.txt").exists()
                            && read_text(working.join("local.txt")) == "unstaged\n"
                        {
                            let _guard = crate::update_worker::repository_lock(
                                &request.config_dir,
                                &request.repo.id,
                                &CancellationToken::new(),
                            )
                            .await
                            .unwrap();
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    }
                })
                .await
                .expect(
                    "worker must finish the update and restoration after the parent was killed",
                );
            }
            assert_eq!(read_text(working.join("local.txt")), "unstaged\n");
            assert_eq!(read_text(working.join("new.txt")), "untracked\n");
            assert_eq!(
                std::fs::read(working.join("new.bin")).unwrap(),
                [0, 255, 17, 99]
            );
            assert!(command_output("git", &["stash", "list"], &working).is_empty());
            assert!(shelf::list(&request.config_dir, &request.repo)
                .await
                .unwrap()
                .is_empty());
        }
    }
}

#[tokio::test]
async fn real_git_ordinary_pull_keeps_untracked_collision_and_restores_tracked_changes() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (remote, working) = update_parity_fixture(root.path());
    let seed = root.path().join("seed");
    command(
        "git",
        &[
            "clone",
            "-b",
            "main",
            remote.to_str().unwrap(),
            seed.to_str().unwrap(),
        ],
        root.path(),
    );
    command("git", &["config", "user.name", "VersionDock Test"], &seed);
    command("git", &["config", "user.email", "test@example.test"], &seed);
    std::fs::write(seed.join("collision.txt"), "upstream\n").unwrap();
    command("git", &["add", "."], &seed);
    command("git", &["commit", "-m", "upstream"], &seed);
    command("git", &["push"], &seed);
    std::fs::write(working.join("local.txt"), "staged\n").unwrap();
    command("git", &["add", "local.txt"], &working);
    std::fs::write(working.join("local.txt"), "unstaged\n").unwrap();
    std::fs::write(working.join("collision.txt"), "local untracked\n").unwrap();
    vcs::sync(
        &repo(&working, VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &Default::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        read_text(working.join("collision.txt")),
        "local untracked\n"
    );
    assert_eq!(read_text(working.join("local.txt")), "unstaged\n");
    assert!(command_output("git", &["diff", "--cached"], &working).contains("+staged"));
    assert!(command_output("git", &["stash", "list"], &working).is_empty());
}

#[tokio::test]
async fn real_git_shelf_storage_failure_restores_before_full_stash_fallback() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    let config = root.path().join("config");
    std::fs::create_dir(&config).unwrap();
    std::fs::write(config.join("shelves"), "not a directory").unwrap();
    std::fs::write(working.join("local.txt"), "local\n").unwrap();
    std::fs::write(working.join("new.txt"), "untracked\n").unwrap();
    vcs::sync_with_worktree_backup(
        &config,
        &repo(&working, VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &Default::default(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(read_text(working.join("local.txt")), "local\n");
    assert_eq!(read_text(working.join("new.txt")), "untracked\n");
    assert!(command_output("git", &["stash", "list"], &working).is_empty());
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "subprocess fixture for real_git_interrupted_update_keeps_durable_backup"]
async fn update_interruption_child() {
    let root = std::path::PathBuf::from(
        std::env::var("VERSIONDOCK_UPDATE_INTERRUPT_ROOT").expect("fixture root"),
    );
    let method = match std::env::var("VERSIONDOCK_UPDATE_INTERRUPT_METHOD")
        .unwrap()
        .as_str()
    {
        "stash" => crate::models::CleanWorkingTreeMethod::Stash,
        _ => crate::models::CleanWorkingTreeMethod::Shelve,
    };
    vcs::sync_with_worktree_backup(
        &root.join("config"),
        &repo(&root.join("working"), VcsKind::Git),
        SyncAction::Pull,
        None,
        None,
        false,
        &crate::models::DesktopSettings {
            update_project_clean_working_tree: method,
            ..Default::default()
        },
        &CancellationToken::new(),
    )
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn real_git_interrupted_update_keeps_durable_backup() {
    use std::os::unix::fs::PermissionsExt;
    if !available("git") {
        return;
    }
    for method in ["shelve", "stash"] {
        let root = tempdir().unwrap();
        let (_, working) = update_parity_fixture(root.path());
        std::fs::write(working.join("local.txt"), "local before interruption\n").unwrap();
        std::fs::write(working.join("new.txt"), "untracked before interruption\n").unwrap();
        std::fs::write(working.join("new.bin"), [0, 255, 17, 99]).unwrap();
        let marker = root.path().join("transport-pid");
        let transport = root.path().join("slow-upload-pack");
        std::fs::write(
            &transport,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nsleep 30\nexec git-upload-pack \"$@\"\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&transport, std::fs::Permissions::from_mode(0o755)).unwrap();
        command(
            "git",
            &[
                "config",
                "remote.origin.uploadpack",
                transport.to_str().unwrap(),
            ],
            &working,
        );
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "integration_tests::update_interruption_child",
                "--nocapture",
            ])
            .env("VERSIONDOCK_UPDATE_INTERRUPT_ROOT", root.path())
            .env("VERSIONDOCK_UPDATE_INTERRUPT_METHOD", method)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let started = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            while !marker.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        child.kill().unwrap();
        child.wait().unwrap();
        if let Ok(pid) = read_text(&marker).trim().parse::<i32>() {
            // CLI gives each spawned VCS process its own process group. Stop only
            // the transport group belonging to this temporary fixture.
            let group = unsafe { libc::getpgid(pid) };
            if group > 0 && group != unsafe { libc::getpgrp() } {
                unsafe {
                    libc::kill(-group, libc::SIGTERM);
                }
            }
        }
        started.expect("real transport must start after durable backup capture");
        assert!(!working.join("new.txt").exists());
        let repository = repo(&working, VcsKind::Git);
        let token = CancellationToken::new();
        if method == "shelve" {
            let values = shelf::list(&root.path().join("config"), &repository)
                .await
                .unwrap();
            assert_eq!(values.len(), 1);
            assert!(values[0].name.starts_with("Auto-shelved before update ("));
            shelf::operate(
                &root.path().join("config"),
                &repository,
                crate::models::ShelfOperation::Apply {
                    shelf_id: values[0].id.clone(),
                    paths: None,
                },
                &token,
            )
            .await
            .unwrap();
        } else {
            let values = vcs::stashes(&repository, &token).await.unwrap();
            assert_eq!(values.len(), 1);
            assert!(values[0]
                .message
                .starts_with("Auto-stashed before update ("));
            vcs::stash_operation(
                &repository,
                StashOperation::Pop {
                    reference: values[0].reference.clone(),
                    expected_hash: Some(values[0].hash.clone()),
                },
                &token,
            )
            .await
            .unwrap();
        }
        assert_eq!(
            read_text(working.join("local.txt")),
            "local before interruption\n"
        );
        assert_eq!(
            read_text(working.join("new.txt")),
            "untracked before interruption\n"
        );
        assert_eq!(
            std::fs::read(working.join("new.bin")).unwrap(),
            [0, 255, 17, 99]
        );
    }
}

#[tokio::test]
async fn real_git_restore_warnings_preserve_actual_update_and_conflict_outcomes() {
    if !available("git") {
        return;
    }
    for method in [
        crate::models::CleanWorkingTreeMethod::Shelve,
        crate::models::CleanWorkingTreeMethod::Stash,
    ] {
        let root = tempdir().unwrap();
        let (remote, working) = update_parity_fixture(root.path());
        let seed = root.path().join("seed");
        command(
            "git",
            &[
                "clone",
                "-b",
                "main",
                remote.to_str().unwrap(),
                seed.to_str().unwrap(),
            ],
            root.path(),
        );
        command("git", &["config", "user.name", "VersionDock Test"], &seed);
        command("git", &["config", "user.email", "test@example.test"], &seed);
        std::fs::write(seed.join("new.txt"), "upstream file\n").unwrap();
        command("git", &["add", "."], &seed);
        command("git", &["commit", "-m", "upstream"], &seed);
        command("git", &["push"], &seed);
        std::fs::write(working.join("new.txt"), "local untracked file\n").unwrap();
        let uses_shelf = matches!(method, crate::models::CleanWorkingTreeMethod::Shelve);
        let result = vcs::sync_with_worktree_backup(
            root.path(),
            &repo(&working, VcsKind::Git),
            SyncAction::Pull,
            None,
            None,
            false,
            &crate::models::DesktopSettings {
                update_project_clean_working_tree: method,
                ..Default::default()
            },
            &CancellationToken::new(),
        )
        .await;
        let warning = if uses_shelf {
            let error = result.unwrap_err();
            assert_eq!(error.code, "GIT_UPDATE_CONFLICT");
            let warning = error.restore_warning.unwrap();
            assert!(warning.conflicted);
            assert!(
                !command_output("git", &["diff", "--name-only", "--diff-filter=U"], &working)
                    .is_empty()
            );
            warning
        } else {
            let result = result.unwrap();
            assert_eq!(result.update.unwrap().summary.unwrap().commit_count, 1);
            assert_eq!(read_text(working.join("new.txt")), "upstream file\n");
            let warning = result.restore_warning.unwrap();
            assert!(!warning.conflicted);
            warning
        };
        assert_eq!(warning.shelf, uses_shelf);
        if uses_shelf {
            let values = shelf::list(root.path(), &repo(&working, VcsKind::Git))
                .await
                .unwrap();
            assert_eq!(values.len(), 1);
            assert_eq!(values[0].id, warning.backup_id);
            let diff = shelf::file_diff(
                root.path(),
                &repo(&working, VcsKind::Git),
                &warning.backup_id,
                "new.txt",
            )
            .await
            .unwrap();
            assert!(diff.content.contains("local untracked file"));
        } else {
            let values = vcs::stashes(&repo(&working, VcsKind::Git), &CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(values.len(), 1);
            assert_eq!(values[0].hash, warning.backup_id);
            assert_eq!(
                command_output("git", &["show", "stash@{0}^3:new.txt"], &working),
                "local untracked file"
            );
        }
    }
}

#[tokio::test]
async fn settings_diff_filters_stash_shelf_and_protection_are_real() {
    use crate::{
        diff_content,
        models::{CatFileFilterMode, DesktopSettings, ShelveComparisonBase},
        protection,
        state::AppState,
    };
    if !available("git") {
        return;
    }
    let dir = tempdir().unwrap();
    let root = dir.path();
    command("git", &["init", "-b", "main"], root);
    command("git", &["config", "user.name", "Test"], root);
    command("git", &["config", "user.email", "test@example.test"], root);
    command(
        "git",
        &["config", "filter.fixture.clean", "sed s/VIEW/RAW/g"],
        root,
    );
    command(
        "git",
        &["config", "filter.fixture.smudge", "sed s/RAW/VIEW/g"],
        root,
    );
    command(
        "git",
        &["config", "diff.fixture.textconv", "sed s/VIEW/TEXT/g"],
        root,
    );
    std::fs::write(
        root.join(".gitattributes"),
        "*.txt filter=fixture diff=fixture\n",
    )
    .unwrap();
    std::fs::write(root.join("file.txt"), "VIEW base\nunchanged\n").unwrap();
    command("git", &["add", "."], root);
    command("git", &["commit", "-m", "base"], root);
    let r = repo(root, VcsKind::Git);
    let t = CancellationToken::new();
    std::fs::write(root.join("file.txt"), "VIEW saved\nunchanged\n").unwrap();
    let filtered = diff_content::file_diff(
        &r,
        "file.txt",
        false,
        None,
        None,
        None,
        &CatFileFilterMode::Filters,
        &t,
    )
    .await
    .unwrap();
    assert!(filtered.content.contains("-VIEW base"));
    assert!(filtered.content.contains("+VIEW saved"));
    let raw = diff_content::file_diff(
        &r,
        "file.txt",
        false,
        None,
        None,
        None,
        &CatFileFilterMode::None,
        &t,
    )
    .await
    .unwrap();
    assert!(raw.content.contains("-RAW base"));
    command("git", &["add", "file.txt"], root);
    let converted = diff_content::file_diff(
        &r,
        "file.txt",
        true,
        None,
        None,
        None,
        &CatFileFilterMode::Textconv,
        &t,
    )
    .await
    .unwrap();
    assert!(converted.content.contains("-TEXT base"));
    assert!(converted.content.contains("+TEXT saved"));
    command("git", &["stash", "push", "-u", "-m", "saved"], root);
    std::fs::write(root.join("file.txt"), "VIEW current\nunchanged\n").unwrap();
    let local = diff_content::stash_diff(
        &r,
        "stash@{0}",
        "file.txt",
        &ShelveComparisonBase::Local,
        &CatFileFilterMode::Filters,
        &t,
    )
    .await
    .unwrap();
    assert!(local.content.contains("-VIEW current"));
    assert!(local.content.contains("+VIEW saved"));
    let parent = diff_content::stash_diff(
        &r,
        "stash@{0}",
        "file.txt",
        &ShelveComparisonBase::Parent,
        &CatFileFilterMode::Filters,
        &t,
    )
    .await
    .unwrap();
    assert!(parent.content.contains("-VIEW base"));
    command("git", &["config", "filter.fixture.smudge", "false"], root);
    let fallback = diff_content::blob(&r, "HEAD:file.txt", &CatFileFilterMode::Filters, &t)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&fallback).contains("RAW base"));
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert_eq!(
        diff_content::blob(&r, "HEAD:file.txt", &CatFileFilterMode::Filters, &cancelled)
            .await
            .unwrap_err()
            .code,
        "REQUEST_CANCELLED"
    );
    command(
        "git",
        &["config", "filter.fixture.smudge", "sed s/RAW/VIEW/g"],
        root,
    );
    let config = tempdir().unwrap();
    let id = shelf::create(config.path(), &r, "saved current", &["file.txt".into()], &t)
        .await
        .unwrap();
    let patch = shelf::file_diff(config.path(), &r, &id, "file.txt")
        .await
        .unwrap();
    let preview = diff_content::apply_preview(&patch.content, "VIEW now\nunchanged\n");
    assert!(preview.contains("RAW current") || preview.contains("VIEW current"));
    assert_eq!(
        std::fs::read_to_string(root.join("file.txt")).unwrap(),
        "VIEW base\nunchanged\n"
    );
    // Native enforcement handles local configuration, ordinary/force push and stale approvals.
    let state = AppState::load(config.path().into());
    {
        let mut snapshot = state.app.write().await;
        snapshot.settings = DesktopSettings::default();
        snapshot.settings.sync_protected_branches_from_github = false;
        snapshot.settings.protected_branches = vec!["main".into()];
    }
    let target = protection::target(&state, &r, None, false, false, &t)
        .await
        .unwrap();
    assert!(target.requires_confirmation);
    assert_eq!(
        protection::enforce_push(&state, &r, None, false, &[], &t)
            .await
            .unwrap_err()
            .code,
        "PROTECTED_PUSH_CONFIRMATION_REQUIRED"
    );
    protection::enforce_push(&state, &r, None, false, std::slice::from_ref(&target), &t)
        .await
        .unwrap();
    state
        .app
        .write()
        .await
        .settings
        .protected_branches
        .push("release/**".into());
    assert!(
        protection::enforce_push(&state, &r, None, false, &[target], &t)
            .await
            .is_err()
    );
    state
        .app
        .write()
        .await
        .settings
        .show_push_dialog_for_protected_branches = false;
    protection::enforce_push(&state, &r, None, false, &[], &t)
        .await
        .unwrap();
    assert!(protection::enforce_push(&state, &r, None, true, &[], &t)
        .await
        .is_err());
    let patterns = vec!["main".into()];
    assert_eq!(
        vcs::branch_operation_with_protection(
            &r,
            BranchOperation::Delete {
                name: "main".into(),
                force: true
            },
            &patterns,
            &t
        )
        .await
        .unwrap_err()
        .code,
        "PROTECTED_BRANCH_DELETE"
    );
}

#[tokio::test]
async fn settings_diff_preview_preserves_newlines_unicode_renames_and_worktree() {
    use crate::{
        diff_content,
        models::{CatFileFilterMode, ShelveComparisonBase},
    };
    if !available("git") {
        return;
    }
    let dir = tempdir().unwrap();
    let root = dir.path();
    let t = CancellationToken::new();
    command("git", &["init", "-b", "main"], root);
    command("git", &["config", "user.name", "Test"], root);
    command("git", &["config", "user.email", "test@example.test"], root);
    let old = "旧 文件.txt";
    let new = "新 文件.txt";
    let base = (0..30).map(|i| format!("line-{i}\n")).collect::<String>();
    std::fs::write(root.join(old), &base).unwrap();
    command("git", &["add", "."], root);
    command("git", &["commit", "-m", "base"], root);
    command("git", &["mv", old, new], root);
    let changed = base.replace("line-15", "saved-15");
    std::fs::write(root.join(new), &changed).unwrap();
    command("git", &["add", "."], root);
    command("git", &["commit", "-m", "rename"], root);
    let r = repo(root, VcsKind::Git);
    let diff = diff_content::file_diff(
        &r,
        new,
        false,
        Some(command_output("git", &["rev-parse", "HEAD"], root)),
        None,
        None,
        &CatFileFilterMode::Filters,
        &t,
    )
    .await
    .unwrap();
    assert!(diff.content.contains("-line-15"), "{}", diff.content);
    assert!(diff.content.contains("+saved-15"));
    assert!(diff.content.contains(" line-0"));
    std::fs::write(root.join(new), changed.replace("line-22", "shelved-22")).unwrap();
    let config = tempdir().unwrap();
    let id = shelf::create(config.path(), &r, "unicode", &[new.into()], &t)
        .await
        .unwrap();
    let patch = shelf::file_diff(config.path(), &r, &id, new).await.unwrap();
    let parent = diff_content::shelf_diff(&r, patch.clone(), &ShelveComparisonBase::Parent, &t)
        .await
        .unwrap();
    assert!(parent.content.contains(" line-0"));
    assert!(parent.content.contains("-line-22"));
    let current = changed.replace("line-0", "current-0");
    std::fs::write(root.join(new), &current).unwrap();
    let local = diff_content::shelf_diff(&r, patch, &ShelveComparisonBase::Local, &t)
        .await
        .unwrap();
    assert!(local.content.contains(" current-0"));
    assert!(local.content.contains("+shelved-22"));
    assert_eq!(std::fs::read_to_string(root.join(new)).unwrap(), current);
    let doc = diff_content::compare("no-newline.txt", b"a\nb", b"a\nc", &t)
        .await
        .unwrap();
    assert!(doc.content.contains("\\ No newline at end of file"));
    assert!(doc.content.contains("+c"));
    let identical = diff_content::compare("same.txt", b"same", b"same", &t)
        .await
        .unwrap();
    assert!(identical.content.contains(" same"));
    assert_eq!(identical.line_count, 1);
    assert!(
        diff_content::compare("binary.bin", b"a\0b", b"a\0c", &t)
            .await
            .unwrap()
            .binary
    );
    let large = vec![b'\n'; 50_001];
    assert!(
        diff_content::compare("large.txt", &[], &large, &t)
            .await
            .unwrap()
            .truncated
    );
    std::fs::write(root.join("new.txt"), "untracked-no-newline").unwrap();
    command("git", &["stash", "push", "-u", "-m", "untracked"], root);
    let untracked = diff_content::stash_diff(
        &r,
        "stash@{0}",
        "new.txt",
        &ShelveComparisonBase::Local,
        &CatFileFilterMode::None,
        &t,
    )
    .await
    .unwrap();
    assert!(untracked.content.contains("+untracked-no-newline"));
    let absent = diff_content::blob(&r, "HEAD:deleted.txt", &CatFileFilterMode::None, &t)
        .await
        .unwrap();
    assert!(absent.is_empty());
}

#[tokio::test]
async fn parity_worktree_outside_app_storage_is_managed_by_git_membership() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    let r = repo(&working, VcsKind::Git);
    let storage = root.path().join("config");
    let t = CancellationToken::new();
    let external = root.path().join("external worktree");
    command(
        "git",
        &[
            "worktree",
            "add",
            "-b",
            "external",
            external.to_str().unwrap(),
        ],
        &working,
    );
    vcs::worktree_operation(
        &storage,
        &r,
        crate::models::WorktreeOperation::Lock {
            path: external.to_string_lossy().into_owned(),
            reason: Some("keep".into()),
        },
        &t,
    )
    .await
    .unwrap();
    let list = vcs::worktrees(&r, &t).await.unwrap();
    assert!(list
        .iter()
        .any(|item| item.lock_reason.as_deref() == Some("keep")));
    vcs::worktree_operation(
        &storage,
        &r,
        crate::models::WorktreeOperation::Unlock {
            path: external.to_string_lossy().into_owned(),
        },
        &t,
    )
    .await
    .unwrap();
    let unrelated = root.path().join("unrelated");
    std::fs::create_dir(&unrelated).unwrap();
    std::fs::write(unrelated.join("keep"), "safe").unwrap();
    assert!(vcs::worktree_operation(
        &storage,
        &r,
        crate::models::WorktreeOperation::Remove {
            path: unrelated.to_string_lossy().into_owned(),
            force: true
        },
        &t
    )
    .await
    .is_err());
    assert!(unrelated.join("keep").exists());
    vcs::worktree_operation(
        &storage,
        &r,
        crate::models::WorktreeOperation::Remove {
            path: external.to_string_lossy().into_owned(),
            force: false,
        },
        &t,
    )
    .await
    .unwrap();
    assert!(!external.exists());
    let chosen = root.path().join("chosen directory");
    vcs::worktree_operation(
        &storage,
        &r,
        crate::models::WorktreeOperation::Create {
            path: chosen.to_string_lossy().into_owned(),
            branch: "chosen".into(),
            new_branch: true,
            commitish: Some("HEAD".into()),
            no_track: true,
        },
        &t,
    )
    .await
    .unwrap();
    assert!(chosen.join(".git").is_file());
}

#[tokio::test]
async fn parity_changelist_lifecycle_and_shelf_restore_recreate_original_group() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    let r = repo(&working, VcsKind::Git);
    let storage = root.path().join("config");
    let t = CancellationToken::new();
    let ws = "ws-0123456789abcdef";
    crate::changelist::operate(
        &storage,
        ws,
        &r,
        crate::models::ChangelistOperation::Create {
            name: "Original group".into(),
        },
    )
    .await
    .unwrap();
    let id = crate::changelist::list(&storage, ws, &r).await.unwrap()[0]
        .id
        .clone();
    crate::changelist::operate(
        &storage,
        ws,
        &r,
        crate::models::ChangelistOperation::Assign {
            changelist_id: Some(id.clone()),
            paths: vec!["local.txt".into()],
        },
    )
    .await
    .unwrap();
    std::fs::write(working.join("local.txt"), "saved change\n").unwrap();
    shelf::operate_in_workspace(
        &storage,
        ws,
        &r,
        crate::models::ShelfOperation::Create {
            name: "saved".into(),
            paths: vec!["local.txt".into()],
        },
        &t,
    )
    .await
    .unwrap();
    let shelf_id = shelf::list(&storage, &r).await.unwrap()[0].id.clone();
    let status = workspace::git_status(r.clone(), &t).await.unwrap();
    crate::changelist::reconcile(&storage, ws, &r, &status.files)
        .await
        .unwrap();
    assert!(crate::changelist::list(&storage, ws, &r).await.unwrap()[0]
        .files
        .is_empty());
    crate::changelist::operate(
        &storage,
        ws,
        &r,
        crate::models::ChangelistOperation::Delete {
            changelist_id: id.clone(),
        },
    )
    .await
    .unwrap();
    shelf::operate_in_workspace(
        &storage,
        ws,
        &r,
        crate::models::ShelfOperation::Apply {
            shelf_id,
            paths: None,
        },
        &t,
    )
    .await
    .unwrap();
    let groups = crate::changelist::list(&storage, ws, &r).await.unwrap();
    assert_eq!(groups[0].id, id);
    assert_eq!(groups[0].name, "Original group");
    assert_eq!(groups[0].files, vec!["local.txt"]);
    command("git", &["add", "."], &working);
    command("git", &["commit", "-m", "saved"], &working);
    let status = workspace::git_status(r.clone(), &t).await.unwrap();
    crate::changelist::reconcile(&storage, ws, &r, &status.files)
        .await
        .unwrap();
    std::fs::write(working.join("local.txt"), "new unrelated change\n").unwrap();
    assert!(crate::changelist::list(&storage, ws, &r).await.unwrap()[0]
        .files
        .is_empty());
}

#[tokio::test]
async fn parity_push_retry_respects_merge_and_rebase_on_the_selected_remote() {
    if !available("git") {
        return;
    }
    for merge in [true, false] {
        let root = tempdir().unwrap();
        let (origin, working) = update_parity_fixture(root.path());
        let secondary = root.path().join("secondary.git");
        command(
            "git",
            &[
                "clone",
                "--bare",
                origin.to_str().unwrap(),
                secondary.to_str().unwrap(),
            ],
            root.path(),
        );
        let upstream = root.path().join("upstream");
        command(
            "git",
            &[
                "clone",
                "-b",
                "main",
                secondary.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ],
            root.path(),
        );
        command("git", &["config", "user.name", "QA"], &upstream);
        command(
            "git",
            &["config", "user.email", "qa@example.test"],
            &upstream,
        );
        std::fs::write(upstream.join("remote-only.txt"), "remote\n").unwrap();
        command("git", &["add", "."], &upstream);
        command("git", &["commit", "-m", "remote"], &upstream);
        command("git", &["push"], &upstream);
        std::fs::write(working.join("local-commit.txt"), "local\n").unwrap();
        command("git", &["add", "."], &working);
        command("git", &["commit", "-m", "local"], &working);
        command(
            "git",
            &["remote", "add", "secondary", secondary.to_str().unwrap()],
            &working,
        );
        let origin_before = command_output("git", &["rev-parse", "main"], &origin);
        let state = crate::state::AppState::load(root.path().join("config"));
        let mut settings = crate::models::DesktopSettings::default();
        settings.protected_branches.clear();
        settings.sync_protected_branches_from_github = false;
        settings.on_push_rejected = crate::models::OnPushRejectedAction::RebaseAndRetry;
        settings.update_project_method = if merge {
            crate::models::UpdateProjectMethod::Merge
        } else {
            crate::models::UpdateProjectMethod::Rebase
        };
        *state.app.write().await = crate::models::AppStateSnapshot {
            settings: settings.clone(),
            ..Default::default()
        };
        let r = repo(&working, VcsKind::Git);
        let t = CancellationToken::new();
        crate::commands::push_with_recovery(
            &state,
            &r,
            Some("secondary".into()),
            None,
            false,
            &settings,
            &[],
            &t,
        )
        .await
        .unwrap();
        assert_eq!(
            command_output("git", &["rev-parse", "HEAD"], &working),
            command_output("git", &["rev-parse", "main"], &secondary)
        );
        assert_eq!(
            origin_before,
            command_output("git", &["rev-parse", "main"], &origin)
        );
        let parents = command_output(
            "git",
            &["rev-list", "--parents", "-n", "1", "HEAD"],
            &working,
        )
        .split_whitespace()
        .count();
        assert_eq!(parents, if merge { 3 } else { 2 });
    }
}

#[tokio::test]
async fn parity_working_comparisons_apply_configured_content_filters() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    let t = CancellationToken::new();
    let r = repo(&working, VcsKind::Git);
    std::fs::write(working.join(".gitattributes"), "local.txt filter=display\n").unwrap();
    command(
        "git",
        &["config", "filter.display.smudge", "sed s/base/converted/g"],
        &working,
    );
    std::fs::write(working.join("local.txt"), "changed\n").unwrap();
    let filtered = crate::diff_content::working_diff(
        &r,
        "local.txt",
        "HEAD",
        &crate::models::CatFileFilterMode::Filters,
        &t,
    )
    .await
    .unwrap();
    let raw = crate::diff_content::working_diff(
        &r,
        "local.txt",
        "HEAD",
        &crate::models::CatFileFilterMode::None,
        &t,
    )
    .await
    .unwrap();
    assert!(filtered.content.contains("-converted"));
    assert!(raw.content.contains("-base"));
    assert_eq!(read_text(working.join("local.txt")), "changed\n");
}

#[tokio::test]
async fn parity_svn_authentication_retries_only_the_original_command_and_honors_cancel() {
    if !available("svnserve") || !available("svnadmin") {
        return;
    }
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for choice in ["authenticate", "cancel"] {
        let root = tempdir().unwrap();
        let repository = root.path().join("repo");
        command(
            "svnadmin",
            &["create", repository.to_str().unwrap()],
            root.path(),
        );
        std::fs::write(repository.join("conf/svnserve.conf"),"[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = Parity test\n").unwrap();
        std::fs::write(repository.join("conf/passwd"), "[users]\nalice = secret\n").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let server = Server(
            Command::new("svnserve")
                .args([
                    "--daemon",
                    "--foreground",
                    "--listen-host",
                    "127.0.0.1",
                    "--listen-port",
                    &port.to_string(),
                    "--root",
                    root.path().to_str().unwrap(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let url = format!("svn://127.0.0.1:{port}/repo");
        let working = root.path().join("working");
        command(
            "svn",
            &[
                "checkout",
                "--non-interactive",
                "--no-auth-cache",
                "--username",
                "alice",
                "--password",
                "secret",
                &url,
                working.to_str().unwrap(),
            ],
            root.path(),
        );
        std::fs::write(working.join("added.txt"), "new\n").unwrap();
        let r = repo(&working, VcsKind::Svn);
        let t = CancellationToken::new();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = count.clone();
        let selected = choice.to_owned();
        let result = crate::interactions::with_test_responder(
            std::sync::Arc::new(move |kind| {
                assert!(matches!(
                    kind,
                    crate::interactions::InteractionKind::SvnAuthentication
                ));
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                crate::interactions::InteractionResponse {
                    choice: selected.clone(),
                    username: Some("alice".into()),
                    password: Some("secret".into()),
                    ..Default::default()
                }
            }),
            vcs::commit(&r, "authenticated", false, &["added.txt".into()], &t),
        )
        .await;
        assert_eq!(
            count.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "authentication result: {result:?}"
        );
        let revision = command_output(
            "svnlook",
            &["youngest", repository.to_str().unwrap()],
            root.path(),
        );
        if choice == "authenticate" {
            result.unwrap();
            assert_eq!(revision.trim(), "1");
        } else {
            assert_eq!(result.unwrap_err().code, "REQUEST_CANCELLED");
            assert_eq!(revision.trim(), "0");
            assert_eq!(read_text(working.join("added.txt")), "new\n");
        }
        drop(server);
    }
}

#[tokio::test]
async fn real_svn_reference_queries_match_plugin_fallback_cooldown_and_request_reuse() {
    if !available("svn") || !available("svnadmin") || !available("svnserve") {
        return;
    }
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = tempdir().unwrap();
    let storage = root.path().join("repo");
    command(
        "svnadmin",
        &["create", storage.to_str().unwrap()],
        root.path(),
    );
    let config = storage.join("conf");
    std::fs::write(config.join("svnserve.conf"), "[general]\nanon-access = write\nauth-access = write\nauthz-db = authz\nrealm = Log audit\n").unwrap();
    std::fs::write(config.join("authz"), "[/]\n* = rw\n").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let _server = Server(
        Command::new("svnserve")
            .args([
                "--daemon",
                "--foreground",
                "--listen-host",
                "127.0.0.1",
                "--listen-port",
                &port.to_string(),
                "--root",
                root.path().to_str().unwrap(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let url = format!("svn://127.0.0.1:{port}/repo");
    let working = root.path().join("working");
    command(
        "svn",
        &[
            "checkout",
            "--non-interactive",
            "--no-auth-cache",
            &url,
            working.to_str().unwrap(),
        ],
        root.path(),
    );
    command(
        "svn",
        &[
            "mkdir",
            "trunk",
            "branches",
            "branches/release",
            "tags",
            "tags/v1",
        ],
        &working,
    );
    command("svn", &["commit", "-m", "layout"], &working);
    let mut repository = repo(&working, VcsKind::Svn);
    repository.id = format!("svn-denied-{}", uuid::Uuid::new_v4());
    let token = CancellationToken::new();
    std::fs::write(
        config.join("authz"),
        "[/]\n* = rw\n[/trunk]\n* =\n[/branches]\n* =\n[/tags]\n* =\n",
    )
    .unwrap();
    let prompts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let logger = crate::logger::get_logger()
        .unwrap_or_else(|| crate::logger::init_global_logger(root.path().join("logs")));
    let observed = prompts.clone();
    let (branches, duplicate_branches, tags, duplicate_tags) =
        crate::interactions::with_test_responder(
            std::sync::Arc::new(move |_| {
                observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                crate::interactions::InteractionResponse {
                    choice: "cancel".into(),
                    ..Default::default()
                }
            }),
            async {
                tokio::join!(
                    vcs::branches(&repository, &token),
                    vcs::branches(&repository, &token),
                    vcs::tags(&repository, &token),
                    vcs::tags(&repository, &token)
                )
            },
        )
        .await;
    assert_eq!(branches.unwrap().len(), 1);
    assert_eq!(duplicate_branches.unwrap().len(), 1);
    assert!(tags.unwrap().is_empty());
    assert!(duplicate_tags.unwrap().is_empty());
    assert_eq!(prompts.load(std::sync::atomic::Ordering::SeqCst), 0);
    let count_queries = || {
        logger
            .get_entries(None, None, None)
            .iter()
            .filter(|entry| {
                entry.cwd.as_deref() == working.to_str()
                    && entry.message.starts_with("svn --non-interactive ls --xml")
            })
            .count()
    };
    assert_eq!(
        count_queries(),
        3,
        "concurrent calls share one remote query per directory"
    );
    // Like the plugin, cold failures return current branch / empty tags for 3 seconds.
    std::fs::write(config.join("authz"), "[/]\n* = rw\n").unwrap();
    assert_eq!(vcs::branches(&repository, &token).await.unwrap().len(), 1);
    assert!(vcs::tags(&repository, &token).await.unwrap().is_empty());
    assert_eq!(count_queries(), 3);
    tokio::time::sleep(std::time::Duration::from_millis(3100)).await;
    let branches = vcs::branches(&repository, &token).await.unwrap();
    assert!(branches.iter().any(|branch| branch.name == "trunk"));
    assert!(branches.iter().any(|branch| branch.name == "release"));
    assert_eq!(vcs::tags(&repository, &token).await.unwrap()[0].name, "v1");
    assert_eq!(count_queries(), 6);
    // Expiring a populated cache must preserve previous data on failure.
    std::fs::write(
        config.join("authz"),
        "[/]\n* = rw\n[/trunk]\n* =\n[/branches]\n* =\n[/tags]\n* =\n",
    )
    .unwrap();
    vcs::invalidate_svn_ref_caches(&repository.id);
    let stale = vcs::branches(&repository, &token).await.unwrap();
    assert!(stale.iter().any(|branch| branch.name == "release"));
    assert_eq!(vcs::tags(&repository, &token).await.unwrap()[0].name, "v1");
    assert_eq!(count_queries(), 9);
    assert!(vcs::branches(&repository, &token)
        .await
        .unwrap()
        .iter()
        .any(|branch| branch.name == "release"));
    assert_eq!(count_queries(), 9);
    std::fs::write(config.join("authz"), "[/]\n* = rw\n").unwrap();
    vcs::invalidate_svn_ref_caches(&repository.id);
    assert_eq!(vcs::tags(&repository, &token).await.unwrap()[0].name, "v1");
    assert_eq!(
        count_queries(),
        10,
        "forced invalidation can retry immediately"
    );
}

#[test]
fn parity_svn_scan_depth_remains_four_when_git_scan_depth_changes() {
    let root = tempdir().unwrap();
    for path in [
        "one/two/three/four/.svn",
        "deep/one/two/three/four/.svn",
        "git/deep/.git",
    ] {
        std::fs::create_dir_all(root.path().join(path)).unwrap();
    }
    let ws = workspace::descriptor(vec![root.path().to_string_lossy().into_owned()]).unwrap();
    for depth in [0, 1, 10] {
        let settings = crate::models::DesktopSettings {
            repository_scan_depth: depth,
            ..Default::default()
        };
        let list = workspace::scan(&ws, &settings).unwrap();
        assert_eq!(list.iter().filter(|r| r.kind == VcsKind::Svn).count(), 1);
        assert_eq!(list.iter().any(|r| r.kind == VcsKind::Git), depth >= 2);
    }
}

#[tokio::test]
async fn parity_multiple_patches_are_separate_and_apply_as_email_patches() {
    if !available("git") {
        return;
    }
    let root = tempdir().unwrap();
    let (_, working) = update_parity_fixture(root.path());
    std::fs::write(working.join("first.txt"), "first\n").unwrap();
    command("git", &["add", "."], &working);
    command("git", &["commit", "-m", "first"], &working);
    let first = command_output("git", &["rev-parse", "HEAD"], &working)
        .trim()
        .to_owned();
    std::fs::write(working.join("binary.bin"), b"one\0two").unwrap();
    command("git", &["add", "."], &working);
    command("git", &["commit", "-m", "binary"], &working);
    let second = command_output("git", &["rev-parse", "HEAD"], &working)
        .trim()
        .to_owned();
    let export = root.path().join("patches");
    std::fs::create_dir(&export).unwrap();
    let t = CancellationToken::new();
    let r = repo(&working, VcsKind::Git);
    let paths = vcs::save_patches(
        &r,
        &[first.clone(), second.clone()],
        export.to_str().unwrap(),
        &t,
    )
    .await
    .unwrap();
    assert_eq!(paths.len(), 2);
    assert!(export.join(format!("{}.patch", &first[..7])).is_file());
    assert!(export.join(format!("{}.patch", &second[..7])).is_file());
    let copy = root.path().join("apply");
    command(
        "git",
        &["clone", working.to_str().unwrap(), copy.to_str().unwrap()],
        root.path(),
    );
    command("git", &["config", "user.name", "QA"], &copy);
    command("git", &["config", "user.email", "qa@example.test"], &copy);
    command("git", &["reset", "--hard", &format!("{first}^")], &copy);
    command("git", &["am", &paths[0], &paths[1]], &copy);
    assert_eq!(
        command_output("git", &["rev-parse", "HEAD^{tree}"], &working),
        command_output("git", &["rev-parse", "HEAD^{tree}"], &copy)
    );
}
