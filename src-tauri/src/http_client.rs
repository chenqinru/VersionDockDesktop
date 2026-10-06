use std::sync::OnceLock;

/// 业务请求继续信任原先的 WebPKI 根证书，并保持证书、主机名校验。
/// 显式配置避免 reqwest 升级后自动切换到平台证书信任集合。
pub(crate) fn builder() -> reqwest::ClientBuilder {
    static TLS: OnceLock<rustls::ClientConfig> = OnceLock::new();
    let config = TLS.get_or_init(|| {
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        rustls::ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
            .with_safe_default_protocol_versions()
            .expect("Ring supports the default TLS protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth()
    });
    reqwest::Client::builder().tls_backend_preconfigured(config.clone())
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    #[tokio::test]
    #[ignore = "requires public HTTPS connectivity"]
    async fn public_https_connects_with_the_business_trust_store() {
        let response = super::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("VersionDock-size-validation")
            .build()
            .unwrap()
            .get("https://api.github.com/meta")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        let metadata: serde_json::Value = response.json().await.unwrap();
        assert!(metadata["ssh_keys"].is_array());
    }

    #[tokio::test]
    async fn rejects_untrusted_https_certificates() {
        let certificate = rustls::pki_types::CertificateDer::from(
            include_bytes!("../test-fixtures/untrusted-server/certificate.der").to_vec(),
        );
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(
            include_bytes!("../test-fixtures/untrusted-server/private-key.der").to_vec(),
        );
        let server = rustls::ServerConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key.into())
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (connection, _) = listener.accept().await.unwrap();
            tokio_rustls::TlsAcceptor::from(Arc::new(server))
                .accept(connection)
                .await
                .is_err()
        });
        let result = super::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
            .get(format!("https://{address}/"))
            .send()
            .await;
        let error = result.unwrap_err();
        assert!(error.is_connect());
        assert!(format!("{error:?}").contains("UnknownIssuer"), "{error:?}");
        assert!(task.await.unwrap());
    }
}
