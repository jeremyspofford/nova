//! The management channel over mutual TLS (D1 of ADR-096; closes R-022 for devices with a
//! certificate). When the device holds `device-cert.pem` (Add Device in local-CA mode), the
//! server the Hub calls (default port 7420) speaks TLS 1.3 only (client certificates travel
//! encrypted), presents that certificate with the device's own Ed25519 key, and requires a client
//! certificate that chains to the Hub local CA novad cached from a verified identity statement
//! (`hub-trust.json`, src/tls.rs), carries EKU clientAuth and the Hub's URI SAN
//! `urn:nova:hub:<pinned fingerprint>`. The bearer management token is still checked on every
//! request (defense in depth). Without a certificate the server stays plain HTTP as before.
//!
//! The configuration is built per connection from the files, so a CA learned later applies at
//! once; when it cannot be built (no cached CA, a damaged certificate, a certificate for another
//! key) every connection is refused: a device with a certificate never falls back to plain HTTP,
//! and privileged requests that reach a plain server anyway are refused (`authz.rs`,
//! `tls_required`). novad registers and heartbeats its endpoint as `https://` once it has a
//! certificate (`advertised_endpoint`).
//!
//! Renewal: a heartbeat answer may carry `certificate: {pem, notAfter}` (a certificate issued in
//! M7 has clientAuth only, and every certificate is renewed when a third of its life is left).
//! `renew` accepts it only when it chains to the cached Hub CA, is valid now, has both serverAuth
//! and clientAuth, holds this device's own key and names `urn:nova:device:<id>`; then it replaces
//! `device-cert.pem` atomically (0600). The listener stays up: each new connection reads the
//! certificate again. A certificate without serverAuth is served as it is until its renewal
//! arrives; the Hub decides whether it accepts it.

use crate::http::{Handler, ServerHandle, Timed};
use crate::state::DataDir;
use crate::tls::{DEVICE_CERT_FILE, HubTrust, TRUST_FILE, ed25519_pkcs8, pem_certificates};
use rustls::client::danger::HandshakeSignatureValid;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, UnixTime};
use rustls::server::WebPkiClientVerifier;
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{CertificateError, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig, ServerConnection, SignatureScheme, StreamOwned};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

pub type ServerStream = StreamOwned<ServerConnection, TcpStream>;

impl Timed for ServerStream {
    fn tcp(&self) -> &TcpStream {
        &self.sock
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The endpoint novad registers and heartbeats: `https://` once it holds a certificate.
pub fn advertised_endpoint(data: &DataDir, endpoint: &str) -> String {
    match endpoint.strip_prefix("http://") {
        Some(rest) if crate::authz::has_certificate(data) => format!("https://{rest}"),
        _ => endpoint.to_string(),
    }
}

/// The Hub client identity a client certificate must name.
pub fn hub_client_uri(pin: &str) -> String {
    format!("urn:nova:hub:{pin}")
}

/// One DER element: (tag, contents, what follows). Definite lengths only.
fn tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *input.first()?;
    let first = *input.get(1)? as usize;
    let (len, header) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *input.get(2 + i)? as usize;
        }
        (len, 2 + n)
    };
    let end = header.checked_add(len)?;
    Some((tag, input.get(header..end)?, input.get(end..)?))
}

/// The elements of a DER sequence's contents: (tag, contents, the whole element).
fn elements(mut input: &[u8]) -> Vec<(u8, &[u8], &[u8])> {
    let mut out = vec![];
    while let Some((tag, body, rest)) = tlv(input) {
        out.push((tag, body, &input[..input.len() - rest.len()]));
        input = rest;
    }
    out
}

fn all(input: &[u8]) -> Vec<(u8, &[u8])> {
    elements(input).into_iter().map(|(t, b, _)| (t, b)).collect()
}

/// The SubjectPublicKeyInfo of a DER certificate, whole (the 7th TBSCertificate field, or the 6th
/// without a version).
pub fn subject_public_key_info(der: &[u8]) -> Option<Vec<u8>> {
    let (0x30, cert, _) = tlv(der)? else { return None };
    let (0x30, tbs, _) = tlv(cert)? else { return None };
    let fields = elements(tbs);
    let skip = usize::from(fields.first()?.0 == 0xa0);
    fields.get(skip + 5).filter(|f| f.0 == 0x30).map(|f| f.2.to_vec())
}

/// The SubjectPublicKeyInfo of a raw Ed25519 key (RFC 8410).
pub fn ed25519_spki(public_key: &[u8; 32]) -> Vec<u8> {
    let mut der = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    der.extend_from_slice(public_key);
    der
}

/// The URI subject alternative names of a DER certificate (RFC 5280 §4.2.1.6), by a minimal DER
/// walk: Certificate > TBSCertificate > [3] extensions > subjectAltName (2.5.29.17) > [6] URIs.
pub fn uri_sans(der: &[u8]) -> Vec<String> {
    const SAN: &[u8] = &[0x55, 0x1d, 0x11];
    let Some((0x30, cert, _)) = tlv(der) else { return vec![] };
    let Some((0x30, tbs, _)) = tlv(cert) else { return vec![] };
    let Some((_, exts)) = all(tbs).into_iter().find(|(t, _)| *t == 0xa3) else { return vec![] };
    let Some((0x30, list, _)) = tlv(exts) else { return vec![] };
    let mut out = vec![];
    for (tag, ext) in all(list) {
        let parts = all(ext);
        if tag != 0x30 || parts.first() != Some(&(0x06, SAN)) {
            continue;
        }
        let Some((_, value)) = parts.iter().find(|(t, _)| *t == 0x04) else { continue };
        let Some((0x30, names, _)) = tlv(value) else { continue };
        out.extend(all(names).into_iter().filter(|(t, _)| *t == 0x86).filter_map(|(_, v)| std::str::from_utf8(v).ok().map(str::to_string)));
    }
    out
}

/// The WebPKI client verifier for the Hub CA (chain, validity, EKU clientAuth), plus the Hub's
/// URI SAN: a certificate the same CA issued to a device is not the Hub.
#[derive(Debug)]
struct HubClientVerifier {
    inner: Arc<dyn ClientCertVerifier>,
    uri: String,
}

impl ClientCertVerifier for HubClientVerifier {
    fn offer_client_auth(&self) -> bool {
        true
    }
    fn client_auth_mandatory(&self) -> bool {
        true
    }
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }
    fn verify_client_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], now: UnixTime) -> Result<ClientCertVerified, rustls::Error> {
        self.inner.verify_client_cert(end_entity, intermediates, now)?;
        if uri_sans(end_entity).iter().any(|u| *u == self.uri) {
            Ok(ClientCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// The server configuration from the data folder: the device certificate and key, the cached
/// Hub CA and the pinned fingerprint. Err says why connections are refused.
pub fn server_config(data: &DataDir) -> Result<Arc<ServerConfig>, String> {
    let pem = std::fs::read_to_string(data.path().join(DEVICE_CERT_FILE)).map_err(|e| format!("the device certificate cannot be read: {e}"))?;
    let chain: Vec<CertificateDer<'static>> = pem_certificates(&pem).into_iter().map(CertificateDer::from).collect();
    if chain.is_empty() {
        return Err("the device certificate is not a PEM certificate".into());
    }
    let seed: [u8; 32] = std::fs::read(data.seed_path()).ok().and_then(|b| b.try_into().ok()).ok_or("the device key cannot be read")?;
    let trust = HubTrust::load(&data.path().join(TRUST_FILE)).unwrap_or_default();
    let pin = trust.pin.clone().ok_or("no Hub fingerprint is pinned; add the device again")?;
    let ca = trust.ca_pem.as_deref().and_then(|p| pem_certificates(p).into_iter().next()).ok_or("the Hub local CA is not known yet (it is learned from the Hub's signed identity)")?;
    let provider = provider();
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(ca)).map_err(|e| format!("the cached Hub CA is not usable: {e}"))?;
    let inner = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().map_err(|e| format!("the client check cannot be set up: {e}"))?;
    let verifier = Arc::new(HubClientVerifier { inner, uri: hub_client_uri(&pin) });
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(ed25519_pkcs8(&seed)));
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .with_client_cert_verifier(verifier)
        .with_single_cert(chain, key)
        .map_err(|e| format!("the device certificate does not match this device's key: {e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Why a renewed device certificate is refused (`check_renewal`).
fn cert_reason(e: rustls::Error, wrong_usage: &'static str) -> &'static str {
    match e {
        rustls::Error::InvalidCertificate(c) => match c {
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => "expired",
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => "not_yet_valid",
            CertificateError::InvalidPurpose | CertificateError::InvalidPurposeContext { .. } => wrong_usage,
            CertificateError::BadEncoding => "malformed",
            _ => "untrusted",
        },
        _ => "untrusted",
    }
}

/// Check a renewed device certificate (PEM, leaf first) for this device; Ok gives the PEM to
/// keep, Err the reason: `not_a_renewal`, `not_pem`, `no_ca`, `not_enrolled`, `untrusted`,
/// `expired`, `not_yet_valid`, `malformed`, `missing_server_auth`, `missing_client_auth`,
/// `wrong_key`, `wrong_device`.
pub fn check_renewal(data: &DataDir, pem: &str, now_secs: u64) -> Result<String, &'static str> {
    // Renewal only: a certificate never turns a plain management channel into TLS behind
    // novad's back (the server's kind is chosen at start).
    if !crate::authz::has_certificate(data) {
        return Err("not_a_renewal");
    }
    let chain: Vec<CertificateDer<'static>> = pem_certificates(pem).into_iter().map(CertificateDer::from).collect();
    let (leaf, intermediates) = chain.split_first().ok_or("not_pem")?;
    let trust = HubTrust::load(&data.path().join(TRUST_FILE)).unwrap_or_default();
    let ca = trust.ca_pem.as_deref().and_then(|p| pem_certificates(p).into_iter().next()).ok_or("no_ca")?;
    let device_id = data.device().ok().flatten().and_then(|d| d.device_id).ok_or("not_enrolled")?;
    let seed: [u8; 32] = std::fs::read(data.seed_path()).ok().and_then(|b| b.try_into().ok()).ok_or("not_enrolled")?;
    let provider = provider();
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(ca)).map_err(|_| "no_ca")?;
    let roots = Arc::new(roots);
    let now = UnixTime::since_unix_epoch(Duration::from_secs(now_secs));
    // The chain, the validity and serverAuth (its management server), then clientAuth (its calls).
    let parsed = rustls::server::ParsedCertificate::try_from(leaf).map_err(|_| "malformed")?;
    rustls::client::verify_server_cert_signed_by_trust_anchor(&parsed, &roots, intermediates, now, provider.signature_verification_algorithms.all).map_err(|e| cert_reason(e, "missing_server_auth"))?;
    let client = WebPkiClientVerifier::builder_with_provider(roots, provider.clone()).build().map_err(|_| "no_ca")?;
    client.verify_client_cert(leaf, intermediates, now).map_err(|e| cert_reason(e, "missing_client_auth"))?;
    if subject_public_key_info(leaf) != Some(ed25519_spki(&crate::crypto::SigningKey::from_seed(&seed).public_key())) {
        return Err("wrong_key");
    }
    if !uri_sans(leaf).contains(&format!("urn:nova:device:{device_id}")) {
        return Err("wrong_device");
    }
    Ok(chain.iter().map(|c| crate::tls::pem_certificate(c)).collect())
}

/// Accept a renewed certificate from a heartbeat answer: checked, then swapped in atomically
/// (0600). Ok(false) when it is the certificate already held.
pub fn renew(data: &DataDir, pem: &str, now_secs: u64) -> Result<bool, String> {
    let keep = check_renewal(data, pem, now_secs).map_err(str::to_string)?;
    let path = data.path().join(DEVICE_CERT_FILE);
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if pem_certificates(&current) == pem_certificates(&keep) {
        return Ok(false);
    }
    crate::util::write_atomic(&path, keep.as_bytes(), true).map_err(|e| format!("cannot keep the renewed certificate: {e}"))?;
    Ok(true)
}

/// Whether the held certificate can serve the management channel as the Hub expects (EKU
/// serverAuth); one issued in M7 cannot, and is served anyway until its renewal arrives.
pub fn has_server_auth(der: &[u8]) -> bool {
    // id-kp-serverAuth, 1.3.6.1.5.5.7.3.1
    const SERVER_AUTH: &[u8] = &[0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01];
    der.windows(SERVER_AUTH.len()).any(|w| w == SERVER_AUTH)
}

/// Unix ms of the last "refusing connections" line, so a flood does not flood the log.
static LAST_LOG: AtomicU64 = AtomicU64::new(0);

fn log_refusal(why: &str) {
    let now = crate::util::now_ms();
    if now.saturating_sub(LAST_LOG.load(Ordering::Relaxed)) >= 60_000 {
        LAST_LOG.store(now, Ordering::Relaxed);
        eprintln!("novad: the management channel refuses connections: {why}");
    }
}

/// One TLS connection: handshake (the client certificate is checked inside it), one request, the
/// answer, close_notify.
fn connection(tcp: TcpStream, data: &DataDir, max_body: usize, handler: &Handler) {
    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = tcp.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let peer = tcp.peer_addr().ok();
    let config = match server_config(data) {
        Ok(c) => c,
        Err(why) => return log_refusal(&why),
    };
    let Ok(conn) = ServerConnection::new(config) else { return };
    let mut tls = StreamOwned::new(conn, tcp);
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    while tls.conn.is_handshaking() {
        if Instant::now() > deadline {
            return;
        }
        if tls.conn.complete_io(&mut tls.sock).is_err() {
            // Send the alert (certificate required, bad certificate) so the client learns why.
            let _ = tls.conn.write_tls(&mut tls.sock);
            return;
        }
    }
    let Some(mut tls) = crate::http::handle_stream(tls, peer, max_body, handler) else { return };
    tls.conn.send_close_notify();
    let _ = tls.flush();
    let _ = tls.sock.shutdown(Shutdown::Write);
    // Read what the peer still sends so closing does not reset the answer away.
    let _ = tls.sock.set_read_timeout(Some(DRAIN_TIMEOUT));
    let mut buf = [0u8; 4096];
    for _ in 0..64 {
        match tls.sock.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

/// Serve the management channel over mutual TLS on `listener` (the accept loop and limits of
/// `http::serve`).
pub fn serve(listener: TcpListener, max_body: usize, data: DataDir, handler: Handler) -> ServerHandle {
    if let Err(why) = server_config(&data) {
        log_refusal(&why);
    }
    let held = std::fs::read_to_string(data.path().join(DEVICE_CERT_FILE)).ok().and_then(|p| pem_certificates(&p).into_iter().next());
    if held.is_some_and(|der| !has_server_auth(&der)) {
        eprintln!("novad: the device certificate has no serverAuth (issued before M7.5); serving it until the Hub renews it");
    }
    crate::http::serve_connections(listener, Arc::new(move |tcp| connection(tcp, &data, max_body, &handler)))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::authz::tests::enrolled;
    use crate::http::{Request, Response};
    use crate::tls::tests::{DEVICE_SEED, Pki, hub_pin};
    use crate::tls::{pem_certificate, HubTrust};
    use rcgen::{CertificateParams, DnType, ExtendedKeyUsagePurpose, Issuer, KeyPair, SanType};
    use rustls::client::danger::{ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::ServerName;
    use rustls::server::ParsedCertificate;
    use rustls::{ClientConfig, ClientConnection};
    use serde_json::{Value, json};

    /// A certificate from the test CA for `key` (PKCS#8 DER), with these URI SANs and EKUs.
    pub fn issue(pki: &Pki, key: &KeyPair, uris: &[&str], ekus: Vec<ExtendedKeyUsagePurpose>) -> Vec<u8> {
        let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
        p.distinguished_name.push(DnType::CommonName, "nova");
        p.subject_alt_names = uris.iter().map(|u| SanType::URI((*u).try_into().unwrap())).collect();
        p.extended_key_usages = ekus;
        p.not_before = rcgen::date_time_ymd(2026, 1, 1);
        p.not_after = rcgen::date_time_ymd(2036, 1, 1);
        p.signed_by(key, &Issuer::from_params(&pki.ca_params, &pki.ca_key)).unwrap().der().to_vec()
    }

    /// How the Hub checks the device (P): chain to the Hub CA and the device's URI SAN, never
    /// the host name.
    /// With `m7`, the chain is checked for clientAuth instead (a certificate issued before M7.5,
    /// which the Hub accepts until its renewal).
    #[derive(Debug)]
    struct DeviceVerifier {
        roots: RootCertStore,
        uri: String,
        provider: Arc<CryptoProvider>,
        m7: bool,
    }

    impl ServerCertVerifier for DeviceVerifier {
        fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], now: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
            if self.m7 {
                WebPkiClientVerifier::builder_with_provider(Arc::new(self.roots.clone()), self.provider.clone()).build().unwrap().verify_client_cert(end_entity, intermediates, now)?;
            } else {
                let cert = ParsedCertificate::try_from(end_entity)?;
                rustls::client::verify_server_cert_signed_by_trust_anchor(&cert, &self.roots, intermediates, now, self.provider.signature_verification_algorithms.all)?;
            }
            if uri_sans(end_entity).contains(&self.uri) { Ok(ServerCertVerified::assertion()) } else { Err(rustls::Error::InvalidCertificate(CertificateError::NotValidForName)) }
        }
        fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(m, c, d, &self.provider.signature_verification_algorithms)
        }
        fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(m, c, d, &self.provider.signature_verification_algorithms)
        }
        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.provider.signature_verification_algorithms.supported_schemes()
        }
    }

    /// The Hub's management client: POST `path` over mutual TLS with `client` (certificate DER and
    /// PKCS#8 key), expecting the device `dev-1`.
    pub fn call(port: u16, ca: &[u8], client: Option<(Vec<u8>, Vec<u8>)>, token: &str, path: &str, body: &Value) -> Result<(u16, Value), String> {
        exchange(port, ca, client, token, path, body, false).map(|(s, v, _)| (s, v))
    }

    /// `call` that also gives the certificate the device served.
    fn exchange(port: u16, ca: &[u8], client: Option<(Vec<u8>, Vec<u8>)>, token: &str, path: &str, body: &Value, m7: bool) -> Result<(u16, Value, Vec<u8>), String> {
        let provider = provider();
        let mut roots = RootCertStore::empty();
        roots.add(CertificateDer::from(ca.to_vec())).unwrap();
        let builder = ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(DeviceVerifier { roots, uri: "urn:nova:device:dev-1".into(), provider, m7 }));
        let config = match client {
            Some((cert, key)) => builder.with_client_auth_cert(vec![CertificateDer::from(cert)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key))).unwrap(),
            None => builder.with_no_client_auth(),
        };
        let tcp = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let conn = ClientConnection::new(Arc::new(config), ServerName::try_from("10.0.0.9").unwrap()).unwrap();
        let mut tls = StreamOwned::new(conn, tcp);
        let payload = serde_json::to_vec(body).unwrap();
        let head = format!("POST {path} HTTP/1.1\r\nHost: device\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
        tls.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
        tls.write_all(&payload).map_err(|e| e.to_string())?;
        tls.flush().map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        match tls.read_to_end(&mut out) {
            Ok(_) => {}
            Err(e) if !out.is_empty() && e.kind() == std::io::ErrorKind::UnexpectedEof => {}
            Err(e) => return Err(e.to_string()),
        }
        let text = String::from_utf8_lossy(&out).to_string();
        let status: u16 = text.get(9..12).and_then(|s| s.parse().ok()).ok_or_else(|| format!("no response: {text:?}"))?;
        let body = text.split_once("\r\n\r\n").map(|x| x.1).unwrap_or_default();
        let served = tls.conn.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec()).unwrap_or_default();
        Ok((status, serde_json::from_str(body).unwrap_or(Value::Null), served))
    }

    /// An enrolled data folder with a device certificate (clientAuth and serverAuth, as the Hub
    /// issues them for D1) and the Hub CA cached.
    pub fn device_with_certificate(name: &str) -> (std::path::PathBuf, DataDir, Pki) {
        let (base, data) = enrolled(name);
        data.save_seed(&DEVICE_SEED).unwrap();
        let pki = Pki::new("Nova Hub CA");
        let key = KeyPair::try_from(ed25519_pkcs8(&DEVICE_SEED).as_slice()).unwrap();
        let cert = issue(&pki, &key, &["urn:nova:device:dev-1"], vec![ExtendedKeyUsagePurpose::ClientAuth, ExtendedKeyUsagePurpose::ServerAuth]);
        std::fs::write(data.path().join(DEVICE_CERT_FILE), pem_certificate(&cert)).unwrap();
        HubTrust { ca_pem: Some(pem_certificate(&pki.ca_der)), ..HubTrust::pinned(&hub_pin()) }.save(&data.path().join(TRUST_FILE)).unwrap();
        (base, data, pki)
    }

    /// A certificate for this device's key (`DEVICE_SEED`) with these URIs, EKUs and validity.
    fn renewal(pki: &Pki, uri: &str, ekus: Vec<ExtendedKeyUsagePurpose>, years: (i32, i32)) -> Vec<u8> {
        let key = KeyPair::try_from(ed25519_pkcs8(&DEVICE_SEED).as_slice()).unwrap();
        let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
        p.distinguished_name.push(DnType::CommonName, "dev-1");
        p.subject_alt_names = vec![SanType::URI(uri.try_into().unwrap())];
        p.extended_key_usages = ekus;
        p.not_before = rcgen::date_time_ymd(years.0, 1, 1);
        p.not_after = rcgen::date_time_ymd(years.1, 1, 1);
        p.signed_by(&key, &Issuer::from_params(&pki.ca_params, &pki.ca_key)).unwrap().der().to_vec()
    }

    pub fn hub_client(pki: &Pki) -> (Vec<u8>, Vec<u8>) {
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let cert = issue(pki, &key, &[&hub_client_uri(&hub_pin())], vec![ExtendedKeyUsagePurpose::ClientAuth]);
        (cert, key.serialize_der())
    }

    #[test]
    fn serves_the_hub_over_mutual_tls_only() {
        let (base, data, pki) = device_with_certificate("mtls");
        let echo: Handler = Arc::new(|req: Request| Response::json(200, &json!({ "path": req.path, "bearer": req.bearer() })));
        let server = serve(TcpListener::bind("127.0.0.1:0").unwrap(), 1 << 20, data.clone(), echo);
        let port = server.local_addr().port();
        let (status, body) = call(port, &pki.ca_der, Some(hub_client(&pki)), "nvdm_test", "/agent/v1/status", &json!({})).unwrap();
        assert_eq!((status, body["path"].as_str(), body["bearer"].as_str()), (200, Some("/agent/v1/status"), Some("nvdm_test")));
        // No client certificate: the handshake fails, nothing reaches the handler.
        assert!(call(port, &pki.ca_der, None, "nvdm_test", "/agent/v1/status", &json!({})).is_err());
        // A certificate of the same CA for a device, not the Hub: refused.
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let other_device = issue(&pki, &key, &["urn:nova:device:dev-2"], vec![ExtendedKeyUsagePurpose::ClientAuth]);
        assert!(call(port, &pki.ca_der, Some((other_device, key.serialize_der())), "nvdm_test", "/agent/v1/status", &json!({})).is_err());
        // The Hub's URI from another CA: refused.
        let stranger = Pki::new("Someone else");
        assert!(call(port, &pki.ca_der, Some(hub_client(&stranger)), "nvdm_test", "/agent/v1/status", &json!({})).is_err());
        // The Hub's URI but only serverAuth: not a client certificate.
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let server_only = issue(&pki, &key, &[&hub_client_uri(&hub_pin())], vec![ExtendedKeyUsagePurpose::ServerAuth]);
        assert!(call(port, &pki.ca_der, Some((server_only, key.serialize_der())), "nvdm_test", "/agent/v1/status", &json!({})).is_err());
        // Plain HTTP to the TLS port gets nowhere.
        let plain = crate::http::post_json(&format!("http://127.0.0.1:{port}/agent/v1/status"), Some("nvdm_test"), &json!({}), Duration::from_secs(3));
        assert!(plain.is_err() || plain.unwrap().0 != 200);
        // Without a cached CA every connection is refused; once learned it works again.
        HubTrust::pinned(&hub_pin()).save(&data.path().join(TRUST_FILE)).unwrap();
        assert!(server_config(&data).unwrap_err().contains("CA"));
        assert!(call(port, &pki.ca_der, Some(hub_client(&pki)), "nvdm_test", "/agent/v1/status", &json!({})).is_err());
        HubTrust { ca_pem: Some(pem_certificate(&pki.ca_der)), ..HubTrust::pinned(&hub_pin()) }.save(&data.path().join(TRUST_FILE)).unwrap();
        assert_eq!(call(port, &pki.ca_der, Some(hub_client(&pki)), "nvdm_test", "/x", &json!({})).unwrap().0, 200);
        server.stop();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn swaps_in_a_renewed_certificate_for_new_connections() {
        use ExtendedKeyUsagePurpose::{ClientAuth, ServerAuth};
        let (base, data, pki) = device_with_certificate("mtls-renew");
        // A certificate issued in M7: clientAuth only. It is served anyway until renewed.
        let m7 = renewal(&pki, "urn:nova:device:dev-1", vec![ClientAuth], (2026, 2036));
        std::fs::write(data.path().join(DEVICE_CERT_FILE), pem_certificate(&m7)).unwrap();
        assert!(!has_server_auth(&m7));
        let echo: Handler = Arc::new(|_: Request| Response::json(200, &json!({ "ok": true })));
        let server = serve(TcpListener::bind("127.0.0.1:0").unwrap(), 1 << 20, data.clone(), echo);
        let port = server.local_addr().port();
        let (status, _, served) = exchange(port, &pki.ca_der, Some(hub_client(&pki)), "t", "/x", &json!({}), true).unwrap();
        assert_eq!((status, served == m7), (200, true));
        // Every refusal leaves the held certificate alone.
        let now = crate::util::now_ms() / 1000;
        let other_key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let cases = [
            (issue(&pki, &other_key, &["urn:nova:device:dev-1"], vec![ClientAuth, ServerAuth]), "wrong_key"),
            (renewal(&pki, "urn:nova:device:dev-2", vec![ClientAuth, ServerAuth], (2026, 2036)), "wrong_device"),
            (renewal(&Pki::new("Someone else"), "urn:nova:device:dev-1", vec![ClientAuth, ServerAuth], (2026, 2036)), "untrusted"),
            (renewal(&pki, "urn:nova:device:dev-1", vec![ClientAuth, ServerAuth], (2020, 2021)), "expired"),
            (renewal(&pki, "urn:nova:device:dev-1", vec![ClientAuth], (2026, 2036)), "missing_server_auth"),
            (renewal(&pki, "urn:nova:device:dev-1", vec![ServerAuth], (2026, 2036)), "missing_client_auth"),
        ];
        for (cert, why) in cases {
            assert_eq!(renew(&data, &pem_certificate(&cert), now).unwrap_err(), why);
        }
        assert_eq!(renew(&data, "not a certificate", now).unwrap_err(), "not_pem");
        assert_eq!(pem_certificates(&std::fs::read_to_string(data.path().join(DEVICE_CERT_FILE)).unwrap()), vec![m7.clone()]);
        // The renewal: swapped atomically (0600); the next connection gets it, the listener stayed.
        let next = renewal(&pki, "urn:nova:device:dev-1", vec![ClientAuth, ServerAuth], (2026, 2036));
        assert_eq!(renew(&data, &pem_certificate(&next), now), Ok(true));
        assert_eq!(renew(&data, &pem_certificate(&next), now), Ok(false), "already held");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(data.path().join(DEVICE_CERT_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        let (status, _, served) = exchange(port, &pki.ca_der, Some(hub_client(&pki)), "t", "/x", &json!({}), false).unwrap();
        assert_eq!((status, served == next), (200, true));
        server.stop();
        // Never a first certificate: that is enrollment, not renewal.
        std::fs::remove_file(data.path().join(DEVICE_CERT_FILE)).unwrap();
        assert_eq!(renew(&data, &pem_certificate(&next), now).unwrap_err(), "not_a_renewal");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_uri_names_and_advertises_https() {
        let (base, data, pki) = device_with_certificate("mtls-uri");
        let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let two = issue(&pki, &key, &["urn:nova:hub:a", "urn:nova:hub:b"], vec![ExtendedKeyUsagePurpose::ClientAuth]);
        assert_eq!(uri_sans(&two), vec!["urn:nova:hub:a".to_string(), "urn:nova:hub:b".into()]);
        assert!(uri_sans(&pki.ca_der).is_empty());
        assert!(uri_sans(b"\x30\x03\x02\x01\x01").is_empty());
        let mine = std::fs::read_to_string(data.path().join(DEVICE_CERT_FILE)).unwrap();
        let spki = subject_public_key_info(&pem_certificates(&mine)[0]).unwrap();
        assert_eq!(spki, ed25519_spki(&crate::crypto::SigningKey::from_seed(&DEVICE_SEED).public_key()));
        assert!(subject_public_key_info(b"\x30\x03\x02\x01\x01").is_none());
        assert_eq!(advertised_endpoint(&data, "http://10.0.0.9:7420"), "https://10.0.0.9:7420");
        std::fs::remove_file(data.path().join(DEVICE_CERT_FILE)).unwrap();
        assert_eq!(advertised_endpoint(&data, "http://10.0.0.9:7420"), "http://10.0.0.9:7420");
        // A certificate for another key is refused at setup.
        let other = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        std::fs::write(data.path().join(DEVICE_CERT_FILE), pem_certificate(&issue(&pki, &other, &["urn:nova:device:dev-1"], vec![ExtendedKeyUsagePurpose::ServerAuth]))).unwrap();
        assert!(server_config(&data).unwrap_err().contains("does not match"));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
