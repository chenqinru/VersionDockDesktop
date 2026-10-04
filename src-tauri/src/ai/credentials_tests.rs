use super::*;
use std::sync::{atomic::AtomicUsize, Barrier};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_readers_share_one_keychain_read() {
    let cache = Arc::new(CredentialCache::default());
    let reads = Arc::new(AtomicUsize::new(0));
    let mut jobs = Vec::new();
    for _ in 0..12 {
        let cache = cache.clone();
        let reads = reads.clone();
        jobs.push(tokio::spawn(async move {
            cache
                .read_with("provider-origin", false, move || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    Ok("synthetic-secret".into())
                })
                .await
                .unwrap()
        }));
    }
    for job in jobs {
        assert_eq!(job.await.unwrap(), "synthetic-secret");
    }
    assert_eq!(reads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn failed_access_stays_cached_until_explicit_retry() {
    let cache = CredentialCache::default();
    let result = cache
        .read_with("denied", false, || Err(storage_error()))
        .await;
    assert_eq!(result.unwrap_err().code, "AI_KEY_ACCESS_FAILED");
    assert!(cache
        .read_with("denied", false, || panic!("must not reprompt"))
        .await
        .is_err());
    assert_eq!(
        cache
            .read_with("denied", true, || Ok("authorized".into()))
            .await
            .unwrap(),
        "authorized"
    );
    assert_eq!(
        cache
            .read_with("denied", false, || panic!("must use cached key"))
            .await
            .unwrap(),
        "authorized"
    );
}

#[tokio::test]
async fn missing_keys_are_cached_and_save_remove_update_the_same_slot() {
    let cache = CredentialCache::default();
    assert_eq!(
        cache
            .read_with("endpoint", false, || Ok(String::new()))
            .await
            .unwrap(),
        ""
    );
    assert_eq!(
        cache
            .read_with("endpoint", false, || panic!("missing key lookup repeats"))
            .await
            .unwrap(),
        ""
    );
    cache
        .write_with("endpoint", "saved".into(), || Ok(()))
        .await
        .unwrap();
    assert_eq!(
        cache
            .read_with("endpoint", false, || panic!("new key must be cached"))
            .await
            .unwrap(),
        "saved"
    );
    cache
        .write_with("endpoint", String::new(), || Ok(()))
        .await
        .unwrap();
    assert_eq!(
        cache
            .read_with("endpoint", false, || panic!("removed key must be empty"))
            .await
            .unwrap(),
        ""
    );
}

#[tokio::test]
async fn failed_writes_do_not_replace_the_last_persisted_key() {
    let cache = CredentialCache::default();
    cache
        .read_with("endpoint", false, || Ok("original".into()))
        .await
        .unwrap();
    assert!(cache
        .write_with("endpoint", "replacement".into(), || Err(storage_error()))
        .await
        .is_err());
    assert_eq!(
        cache
            .read_with("endpoint", false, || panic!("must retain original"))
            .await
            .unwrap(),
        "original"
    );
    assert!(cache
        .write_with("endpoint", String::new(), || Err(storage_error()))
        .await
        .is_err());
    assert_eq!(
        cache
            .read_with("endpoint", false, || panic!(
                "failed deletion must retain original"
            ))
            .await
            .unwrap(),
        "original"
    );
}

#[tokio::test]
async fn providers_and_origins_are_isolated_but_models_and_api_paths_share_keys() {
    use super::super::{models::AiConfig, transport::secure_reference};
    let config = AiConfig {
        api_url: "https://api.example.test/v1".into(),
        ..Default::default()
    };
    let same = AiConfig {
        api_url: "https://api.example.test/v1/responses".into(),
        model: "another-model".into(),
        ..config.clone()
    };
    let other = AiConfig {
        provider: "custom".into(),
        ..config.clone()
    };
    let host = AiConfig {
        api_url: "https://other.example.test/v1".into(),
        ..config.clone()
    };
    let port = AiConfig {
        api_url: "https://api.example.test:8443/v1".into(),
        ..config.clone()
    };
    assert_eq!(secure_reference(&config), secure_reference(&same));
    for candidate in [&other, &host, &port] {
        assert_ne!(secure_reference(&config), secure_reference(candidate));
    }
    let cache = CredentialCache::default();
    for (reference, secret) in [
        (secure_reference(&config), "first"),
        (secure_reference(&other), "second"),
    ] {
        cache
            .write_with(&reference, secret.into(), || Ok(()))
            .await
            .unwrap();
    }
    assert_eq!(
        cache
            .read_with(&secure_reference(&same), false, || panic!())
            .await
            .unwrap(),
        "first"
    );
    assert_eq!(
        cache
            .read_with(&secure_reference(&other), false, || panic!())
            .await
            .unwrap(),
        "second"
    );
    // A new process/cache must read secure storage again, rather than persist plaintext.
    let next_process = CredentialCache::default();
    assert_eq!(
        next_process
            .read_with(&secure_reference(&same), false, || Ok(
                "fresh process".into()
            ))
            .await
            .unwrap(),
        "fresh process"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancelled_caller_cannot_drop_an_inflight_read_or_overwrite_a_later_save() {
    let cache = Arc::new(CredentialCache::default());
    let started = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let c = cache.clone();
    let start = started.clone();
    let gate = release.clone();
    let read = tokio::spawn(async move {
        c.read_with("racing", false, move || {
            start.wait();
            gate.wait();
            Ok("old key".into())
        })
        .await
    });
    started.wait();
    read.abort();
    let c = cache.clone();
    let save =
        tokio::spawn(async move { c.write_with("racing", "new key".into(), || Ok(())).await });
    release.wait();
    save.await.unwrap().unwrap();
    assert_eq!(
        cache
            .read_with("racing", false, || panic!("stale read overwrote save"))
            .await
            .unwrap(),
        "new key"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn queued_refresh_shares_a_read_that_just_finished() {
    let cache = Arc::new(CredentialCache::default());
    let entry = cache.entry("refresh").unwrap();
    let mut guard = entry.value.clone().lock_owned().await;
    let c = cache.clone();
    let pending = tokio::spawn(async move {
        c.read_with("refresh", true, || {
            panic!("fresh authorization must not repeat")
        })
        .await
    });
    // Wait until the refresh has actually queued on the held mutex.
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while Arc::strong_count(&entry.value) < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("refresh must queue on the credential slot");
    *guard = Some(Ok("just authorized".into()));
    entry.revision.fetch_add(1, Ordering::Release);
    drop(guard);
    assert_eq!(pending.await.unwrap().unwrap(), "just authorized");
}
