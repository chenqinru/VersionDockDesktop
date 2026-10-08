use super::*;

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
    let cache = CredentialCache::new(storage_error);
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
    let next_process = CredentialCache::new(storage_error);
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
