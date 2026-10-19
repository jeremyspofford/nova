//! TLS to the Hub (R-023, FR-126, FR-134; docs/22 §5): rustls with the ring provider.
//!
//! novad trusts a Hub connection the way docs/22 §5 tells native shells to, with the fingerprint
//! pinned at Add Device (`--pin`): the server's certificate is trusted when it was issued by the
//! Hub local CA novad learned from a verified identity statement (issuer, signature, validity,
//! serverAuth and a SAN for the host dialed; the CA's name constraints apply), or when its SHA-256
//! is a leaf or mesh certificate such a statement listed. Otherwise the connection is
//! provisional: before anything else is sent on it, novad asks the Hub on that same connection for
//! its identity statement with a fresh nonce (`GET /api/v1/trust/identity`) and checks it as
//! `checkHubIdentity` (packages/core/src/trust/pinning.ts) does: the key hashes to the pin, the
//! Ed25519 signature verifies, the nonce is this one, and the chain shown is listed or issued by
//! the listed CA. What it vouches for is cached (`hub-trust.json`) for later connections. novad
//! has no platform trust store, so a statement saying `pinning: off` changes nothing: the listed
//! certificates still have to match (stricter, never weaker).
//!
//! With a device certificate (Add Device in local-CA mode) every trusted connection presents it
//! as the client certificate, signed with the device's own Ed25519 key (mutual TLS, FR-126). A
//! provisional connection never does: the certificate names the device, and an unverified server
//! learns nothing; after the statement check novad reconnects with it.

use crate::crypto::{self, b64_decode, b64url_decode, b64url_encode, hex, random_bytes, sha256};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{
    AlertDescription, CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, RootCertStore, SignatureScheme, StreamOwned,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// The domain tag of the Hub's identity statement (`hubIdentityStatementBytes` in @nova/shared).
pub const STATEMENT_TAG: &str = "nova-hub-identity-v1\n";
/// Where a data folder keeps what novad learned about the Hub's certificates.
pub const TRUST_FILE: &str = "hub-trust.json";
/// The device certificate Add Device granted (local-CA mode only).
pub const DEVICE_CERT_FILE: &str = "device-cert.pem";

pub type TlsStream = StreamOwned<ClientConnection, TcpStream>;

/// A certificate a verified statement listed (the Hub's leaf or a mesh certificate).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    /// SHA-256 of the DER, lowercase hex.
    pub sha256: String,
    pub not_after: String,
}

/// What novad trusts about its Hub (`hub-trust.json`): the pin, and what the last verified
/// statement vouched for.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HubTrust {
    /// base64url(SHA-256(the Hub identity's raw Ed25519 key)), from Add Device.
    pub pin: Option<String>,
    /// The Hub local CA, PEM, after a statement listed its SHA-256.
    pub ca_pem: Option<String>,
    pub listed: Vec<Listed>,
    pub verified_at: Option<String>,
}

impl HubTrust {
    pub fn pinned(pin: &str) -> Self {
        HubTrust { pin: Some(pin.to_string()), ..Default::default() }
    }

    pub fn load(path: &Path) -> Option<HubTrust> {
        crate::util::read_json_or::<Option<HubTrust>>(path, None).ok().flatten()
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        crate::util::write_json(path, self, true)
    }

    fn ca_der(&self) -> Option<Vec<u8>> {
        self.ca_pem.as_deref().and_then(|p| pem_certificates(p).into_iter().next())
    }
}

/// The device certificate and its key, as rustls takes them. The PKCS#8 copy of the seed is wiped
/// on drop.
pub struct ClientCert {
    chain: Vec<CertificateDer<'static>>,
    pkcs8: Vec<u8>,
}

impl std::fmt::Debug for ClientCert {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ClientCert({} certificates)", self.chain.len())
    }
}

impl Drop for ClientCert {
    fn drop(&mut self) {
        self.pkcs8.fill(0);
        std::hint::black_box(&self.pkcs8);
    }
}

impl ClientCert {
    /// The PEM certificate (the device's Ed25519 key signed by the Hub CA) and the device seed.
    pub fn new(cert_pem: &str, seed: &[u8; 32]) -> Result<ClientCert, String> {
        let chain: Vec<CertificateDer<'static>> = pem_certificates(cert_pem).into_iter().map(CertificateDer::from).collect();
        if chain.is_empty() {
            return Err("the device certificate is not a PEM certificate".into());
        }
        let c = ClientCert { chain, pkcs8: ed25519_pkcs8(seed) };
        // A certificate for another key (an older enrollment) would fail every handshake.
        rustls::sign::CertifiedKey::from_der(c.chain.clone(), c.key(), &provider()).map_err(|e| format!("the device certificate does not match this device's key: {e}"))?;
        Ok(c)
    }

    fn key(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.pkcs8.clone()))
    }
}

/// RFC 8410 PKCS#8 v1 for an Ed25519 seed: the fixed prefix, then the 32 bytes.
pub fn ed25519_pkcs8(seed: &[u8; 32]) -> Vec<u8> {
    let mut der = vec![0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
    der.extend_from_slice(seed);
    der
}

/// The DER of every CERTIFICATE block in a PEM text.
pub fn pem_certificates(pem: &str) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
        let after = &rest[start + 27..];
        let Some(end) = after.find("-----END CERTIFICATE-----") else { break };
        let body: String = after[..end].chars().filter(|c| !c.is_whitespace()).collect();
        if let Some(der) = b64_decode(&body) {
            out.push(der);
        }
        rest = &after[end + 25..];
    }
    out
}

/// PEM of one DER certificate (64-character lines).
pub fn pem_certificate(der: &[u8]) -> String {
    let b64 = crypto::b64_encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

fn sha256_hex(der: &[u8]) -> String {
    hex(&sha256(der))
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// What the Hub's connection showed and whether the cached trust vouched for it.
#[derive(Debug, Default)]
struct Seen {
    chain: Vec<Vec<u8>>,
    trusted: bool,
}

/// rustls calls this during the handshake. A chain the cached trust vouches for is accepted;
/// with a pin and nothing cached that matches, the connection is accepted provisionally and the
/// caller checks the statement before anything else crosses it. The handshake signature is
/// always verified, so the server holds the key of the certificate it showed.
#[derive(Debug)]
struct HubVerifier {
    provider: Arc<CryptoProvider>,
    ca: Option<Arc<WebPkiServerVerifier>>,
    listed: Vec<Listed>,
    provisional_ok: bool,
    seen: Arc<Mutex<Seen>>,
}

impl ServerCertVerifier for HubVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let mut trusted = self.ca.as_ref().is_some_and(|v| v.verify_server_cert(end_entity, intermediates, server_name, ocsp, now).is_ok());
        if !trusted {
            let hash = sha256_hex(end_entity);
            let secs = now.as_secs();
            trusted = self.listed.iter().any(|l| l.sha256 == hash && crate::util::parse_iso(&l.not_after).is_some_and(|t| t / 1000 >= secs)) && valid_at(end_entity, secs);
        }
        let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
        seen.chain = std::iter::once(end_entity).chain(intermediates).map(|c| c.to_vec()).collect();
        seen.trusted = trusted;
        if trusted || self.provisional_ok { Ok(ServerCertVerified::assertion()) } else { Err(rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer)) }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// A WebPKI verifier that trusts exactly this CA (with its name constraints).
fn ca_verifier(ca_der: &[u8], provider: &Arc<CryptoProvider>) -> Option<Arc<WebPkiServerVerifier>> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(ca_der.to_vec())).ok()?;
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().ok()
}

/// How a Hub connection is made: the trust, the device certificate, where learned trust is kept.
pub struct TlsContext {
    trust: Mutex<HubTrust>,
    client: Option<ClientCert>,
    store: Option<PathBuf>,
}

/// Why the identity statement does not vouch for this connection (docs/22 §5 step 4-6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    PinMismatch,
    BadSignature,
    NonceMismatch,
    NoCertificate,
    NotListed,
    NotServerCertificate,
    HostMismatch,
    Expired,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::PinMismatch => "pin_mismatch",
            Refusal::BadSignature => "bad_signature",
            Refusal::NonceMismatch => "nonce_mismatch",
            Refusal::NoCertificate => "no_certificate",
            Refusal::NotListed => "not_listed",
            Refusal::NotServerCertificate => "not_server_certificate",
            Refusal::HostMismatch => "host_mismatch",
            Refusal::Expired => "expired",
        }
    }
}

/// The exact bytes the statement's signature covers: the tag, then the JSON of the fields in the
/// order @nova/shared's `hubIdentityStatementBytes` writes them (JSON.stringify of a fixed
/// object). None when a field is missing or has the wrong type.
pub fn statement_bytes(s: &Value) -> Option<String> {
    let str_field = |k: &str| s.get(k).and_then(Value::as_str).map(|v| serde_json::to_string(v).unwrap_or_default());
    let v = s.get("v").filter(|v| v.is_number())?;
    let mut certs = Vec::new();
    for c in s.get("certificates")?.as_array()? {
        let f = |k: &str| c.get(k).and_then(Value::as_str).map(|v| serde_json::to_string(v).unwrap_or_default());
        certs.push(format!("{{\"kind\":{},\"sha256\":{},\"notAfter\":{}}}", f("kind")?, f("sha256")?, f("notAfter")?));
    }
    Some(format!(
        "{STATEMENT_TAG}{{\"v\":{v},\"nonce\":{},\"hubFingerprint\":{},\"hubPublicKey\":{},\"pinning\":{},\"certificates\":[{}],\"issuedAt\":{}}}",
        str_field("nonce")?,
        str_field("hubFingerprint")?,
        str_field("hubPublicKey")?,
        str_field("pinning")?,
        certs.join(","),
        str_field("issuedAt")?,
    ))
}

/// The statement's key, signature and nonce, checked against the pin (steps 4 of docs/22 §5).
/// Ok gives the listed certificates by kind.
pub fn check_signed(s: &Value, pin: &str, nonce: &str) -> Result<(), Refusal> {
    let key_text = s["hubPublicKey"].as_str().unwrap_or_default();
    let key: [u8; 32] = b64url_decode(key_text).filter(|b| b64url_encode(b) == key_text).and_then(|b| b.try_into().ok()).ok_or(Refusal::PinMismatch)?;
    if s["hubFingerprint"].as_str() != Some(pin) || crate::install::fingerprint(&key) != pin {
        return Err(Refusal::PinMismatch);
    }
    let sig: [u8; 64] = s["signature"].as_str().and_then(b64url_decode).and_then(|b| b.try_into().ok()).ok_or(Refusal::BadSignature)?;
    let bytes = statement_bytes(s).ok_or(Refusal::BadSignature)?;
    if !crypto::verify(&key, bytes.as_bytes(), &sig) {
        return Err(Refusal::BadSignature);
    }
    // A statement for another request (an old one replayed) carries another nonce.
    if s["nonce"].as_str() != Some(nonce) {
        return Err(Refusal::NonceMismatch);
    }
    Ok(())
}

fn listed_of(s: &Value, kinds: &[&str]) -> Vec<Listed> {
    s["certificates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["kind"].as_str().is_some_and(|k| kinds.contains(&k)))
        .filter_map(|c| Some(Listed { sha256: c["sha256"].as_str()?.to_ascii_lowercase(), not_after: c["notAfter"].as_str()?.to_string() }))
        .collect()
}

/// Whether the statement vouches for this chain (leaf first) on a connection to `host` (docs/22
/// §5 step 6): the leaf is listed and within its validity, or it is a server certificate for the
/// host issued by the CA the statement lists (the CA must be in the chain). Ok names the CA's
/// DER when one vouched or was shown, for the cache.
pub fn check_chain(s: &Value, host: &str, chain: &[Vec<u8>], now_secs: u64) -> Result<Option<Vec<u8>>, Refusal> {
    let leaf = chain.first().ok_or(Refusal::NoCertificate)?;
    let ca_hash = listed_of(s, &["ca"]).into_iter().next().map(|l| l.sha256);
    let ca = ca_hash.as_ref().and_then(|h| chain.iter().find(|c| sha256_hex(c) == *h)).cloned();
    let leaf_hash = sha256_hex(leaf);
    if listed_of(s, &["leaf", "mesh"]).iter().any(|l| l.sha256 == leaf_hash) {
        return if valid_at(leaf, now_secs) { Ok(ca) } else { Err(Refusal::Expired) };
    }
    let ca_der = ca.ok_or(Refusal::NotListed)?;
    let provider = provider();
    let verifier = ca_verifier(&ca_der, &provider).ok_or(Refusal::NotListed)?;
    let name = ServerName::try_from(host.trim_start_matches('[').trim_end_matches(']').to_string()).map_err(|_| Refusal::HostMismatch)?;
    let intermediates: Vec<CertificateDer<'_>> = chain[1..].iter().map(|c| CertificateDer::from(c.as_slice())).collect();
    match verifier.verify_server_cert(&CertificateDer::from(leaf.as_slice()), &intermediates, &name, &[], UnixTime::since_unix_epoch(std::time::Duration::from_secs(now_secs))) {
        Ok(_) => Ok(Some(ca_der)),
        Err(rustls::Error::InvalidCertificate(e)) => Err(match e {
            CertificateError::Expired | CertificateError::ExpiredContext { .. } | CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => Refusal::Expired,
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => Refusal::HostMismatch,
            CertificateError::InvalidPurpose | CertificateError::InvalidPurposeContext { .. } => Refusal::NotServerCertificate,
            CertificateError::Other(o) if format!("{o:?}").contains("CaUsedAsEndEntity") => Refusal::NotServerCertificate,
            _ => Refusal::NotListed,
        }),
        Err(_) => Err(Refusal::NotListed),
    }
}

impl TlsContext {
    pub fn new(trust: HubTrust) -> TlsContext {
        TlsContext { trust: Mutex::new(trust), client: None, store: None }
    }

    /// Present this device certificate on trusted connections.
    pub fn with_client(mut self, client: Option<ClientCert>) -> TlsContext {
        self.client = client;
        self
    }

    /// Keep what verified statements vouch for in this file.
    pub fn with_store(mut self, path: PathBuf) -> TlsContext {
        self.store = Some(path);
        self
    }

    /// The context of an enrolled data folder: `hub-trust.json`, and the device certificate with
    /// the device key when there is one. None when the folder has no pin (an older enrollment).
    pub fn for_data(data: &crate::state::DataDir) -> Option<TlsContext> {
        let path = data.path().join(TRUST_FILE);
        let trust = HubTrust::load(&path).filter(|t| t.pin.is_some())?;
        let client = std::fs::read_to_string(data.path().join(DEVICE_CERT_FILE)).ok().and_then(|pem| {
            let seed = std::fs::read(data.seed_path()).ok()?;
            let seed: [u8; 32] = seed.try_into().ok()?;
            ClientCert::new(&pem, &seed).ok()
        });
        Some(TlsContext::new(trust).with_client(client).with_store(path))
    }

    pub fn trust(&self) -> HubTrust {
        self.trust.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn config(&self, snapshot: &HubTrust, client: bool, seen: Arc<Mutex<Seen>>) -> Result<ClientConfig, String> {
        let provider = provider();
        let verifier = HubVerifier {
            ca: snapshot.ca_der().and_then(|der| ca_verifier(&der, &provider)),
            listed: snapshot.listed.clone(),
            // A handshake that presents the device certificate never goes ahead on an unverified
            // certificate: the device's name and key stay with the verified Hub.
            provisional_ok: snapshot.pin.is_some() && !client,
            seen,
            provider: provider.clone(),
        };
        let builder = ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(|e| format!("TLS setup failed: {e}"))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier));
        let mut config = match (&self.client, client) {
            (Some(c), true) => builder.with_client_auth_cert(c.chain.clone(), c.key()).map_err(|e| format!("the device certificate cannot be used: {e}"))?,
            _ => builder.with_no_client_auth(),
        };
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(config)
    }

    fn handshake(&self, tcp: TcpStream, host: &str, client: bool, deadline: Instant, seen: &Arc<Mutex<Seen>>) -> Result<TlsStream, String> {
        let snapshot = self.trust();
        let config = self.config(&snapshot, client, seen.clone())?;
        let name = ServerName::try_from(host.trim_start_matches('[').trim_end_matches(']').to_string()).map_err(|_| format!("{host} is not a valid TLS server name"))?;
        let conn = ClientConnection::new(Arc::new(config), name).map_err(|e| format!("TLS setup failed: {e}"))?;
        let mut tls = StreamOwned::new(conn, tcp);
        while tls.conn.is_handshaking() {
            let left = crate::http::time_left(deadline).ok_or("timed out during the TLS handshake")?;
            let _ = tls.sock.set_read_timeout(Some(left));
            let _ = tls.sock.set_write_timeout(Some(left));
            if let Err(e) = tls.conn.complete_io(&mut tls.sock) {
                return Err(match explain(&e) {
                    Some(why) => why,
                    None => format!("the TLS handshake with the Hub failed: {e}"),
                });
            }
        }
        Ok(tls)
    }

    /// A TLS connection to the Hub at `host` that this context trusts, made by `dial`. A
    /// provisional connection is checked with the identity statement first (and, when this
    /// device has a certificate, replaced by a new connection that presents it).
    pub fn connect(&self, dial: &dyn Fn() -> Result<TcpStream, String>, host: &str, authority: &str, deadline: Instant) -> Result<TlsStream, String> {
        let pin = self.trust().pin;
        let client = self.client.is_some();
        let untrusted = |seen: &Arc<Mutex<Seen>>| {
            let s = seen.lock().unwrap_or_else(|p| p.into_inner());
            !s.chain.is_empty() && !s.trusted
        };
        // With a certificate, first try a connection the cache vouches for, presenting it; the
        // verifier ends any other handshake before the certificate is sent.
        if client && self.can_vouch() {
            let seen = Arc::new(Mutex::new(Seen::default()));
            match self.handshake(dial()?, host, true, deadline, &seen) {
                Ok(tls) => return Ok(tls),
                // An unknown certificate: check it on a connection that names nobody.
                Err(_) if untrusted(&seen) => {}
                Err(e) => return Err(e),
            }
        }
        let seen = Arc::new(Mutex::new(Seen::default()));
        let mut tls = self.handshake(dial()?, host, false, deadline, &seen)?;
        let (chain, trusted) = {
            let s = seen.lock().unwrap_or_else(|p| p.into_inner());
            (s.chain.clone(), s.trusted)
        };
        if !trusted {
            let pin = pin.ok_or("the Hub's certificate is not trusted and no Hub fingerprint is pinned")?;
            self.verify_statement(&mut tls, &pin, host, authority, &chain, deadline)?;
        }
        if client {
            drop(tls);
            let seen = Arc::new(Mutex::new(Seen::default()));
            return self.handshake(dial()?, host, true, deadline, &seen).map_err(|e| {
                if untrusted(&seen) { "the Hub showed a different certificate on the next connection; stopping".to_string() } else { e }
            });
        }
        Ok(tls)
    }

    fn can_vouch(&self) -> bool {
        let t = self.trust.lock().unwrap_or_else(|p| p.into_inner());
        t.ca_pem.is_some() || !t.listed.is_empty()
    }

    /// Steps 3-6 of docs/22 §5 on this connection, then cache what the statement vouched for.
    fn verify_statement(&self, tls: &mut TlsStream, pin: &str, host: &str, authority: &str, chain: &[Vec<u8>], deadline: Instant) -> Result<(), String> {
        let mut n = [0u8; 24];
        random_bytes(&mut n)?;
        let nonce = b64url_encode(&n);
        let path = format!("/api/v1/trust/identity?nonce={nonce}");
        let r = crate::http::exchange_on(tls, "GET", authority, &path, &[], None, true, deadline).map_err(|e| format!("the Hub's identity statement could not be read: {e}"))?;
        if r.status != 200 {
            return Err(format!("the Hub answered {} for its identity statement; is this a Nova Hub?", r.status));
        }
        let s = r.json()?;
        let now = crate::util::now_ms() / 1000;
        let refused = |why: Refusal| format!("This is not your Hub: its certificate is not vouched for by the pinned Hub identity ({}); nothing was sent", why.reason());
        check_signed(&s, pin, &nonce).map_err(refused)?;
        let ca = check_chain(&s, host, chain, now).map_err(refused)?;
        self.learn(&s, ca)
    }

    /// Cache a verified statement's CA (when the chain carried it) and listed certificates.
    pub fn learn(&self, s: &Value, ca: Option<Vec<u8>>) -> Result<(), String> {
        let mut t = self.trust.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(der) = ca {
            t.ca_pem = Some(pem_certificate(&der));
        } else if listed_of(s, &["ca"]).is_empty() {
            // The Hub no longer has a local CA.
            t.ca_pem = None;
        }
        t.listed = listed_of(s, &["leaf", "mesh"]);
        t.verified_at = Some(crate::util::now_iso());
        if let Some(path) = &self.store {
            t.save(path).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
        }
        Ok(())
    }
}

/// Learn the Hub local CA over plain HTTP at enrollment (FR-134): the statement is signed by the
/// pinned identity and carries this request's nonce, so the CA it lists (by SHA-256) is the
/// Hub's even though the connection is not secret. Later HTTPS connections then trust certificates
/// it issued. Ok(false) when the Hub has no local CA.
pub fn learn_ca_over_http(hub: &str, ctx: &TlsContext, timeout: std::time::Duration) -> Result<bool, String> {
    let pin = ctx.trust().pin.ok_or("no Hub fingerprint is pinned")?;
    let mut n = [0u8; 24];
    random_bytes(&mut n)?;
    let nonce = b64url_encode(&n);
    let r = crate::http::request("GET", &format!("{hub}/api/v1/trust/identity?nonce={nonce}"), &[], None, timeout)?;
    if r.status != 200 {
        return Ok(false);
    }
    let s = r.json()?;
    check_signed(&s, &pin, &nonce).map_err(|why| format!("the Hub's identity statement does not match the pin ({})", why.reason()))?;
    let Some(want) = listed_of(&s, &["ca"]).into_iter().next() else {
        ctx.learn(&s, None)?;
        return Ok(false);
    };
    let ca = crate::http::request("GET", &format!("{hub}/api/v1/trust/ca.pem"), &[], None, timeout)?;
    let der = (ca.status == 200).then(|| pem_certificates(&String::from_utf8_lossy(&ca.body)).into_iter().next()).flatten();
    match der {
        Some(der) if sha256_hex(&der) == want.sha256 => {
            ctx.learn(&s, Some(der))?;
            Ok(true)
        }
        _ => Err("the Hub's CA certificate does not match its signed identity statement".into()),
    }
}

/// A plain-language reason for TLS failures worth naming (the Hub refusing this device's
/// certificate), from an I/O error rustls produced.
pub fn explain(e: &io::Error) -> Option<String> {
    let inner = e.get_ref()?.downcast_ref::<rustls::Error>()?;
    Some(match inner {
        rustls::Error::AlertReceived(AlertDescription::CertificateRevoked) => "the Hub refused this device's certificate: it was revoked; add the device again".into(),
        rustls::Error::AlertReceived(AlertDescription::CertificateRequired) => "the Hub requires a device certificate and this device has none; add the device again".into(),
        rustls::Error::AlertReceived(a @ (AlertDescription::BadCertificate | AlertDescription::UnknownCA | AlertDescription::CertificateExpired | AlertDescription::CertificateUnknown)) => {
            format!("the Hub refused this device's certificate ({a:?})")
        }
        rustls::Error::InvalidCertificate(c) => format!("the Hub's certificate is not trusted ({c:?})"),
        other => format!("TLS error: {other}"),
    })
}

/// Whether a DER certificate's validity covers `now` (Unix seconds). A minimal DER walk to the
/// TBSCertificate's `validity` (RFC 5280 §4.1.2.5); anything unexpected is invalid.
pub fn valid_at(der: &[u8], now: u64) -> bool {
    validity(der).is_some_and(|(from, to)| from <= now && now <= to)
}

/// (notBefore, notAfter) in Unix seconds.
pub fn validity(der: &[u8]) -> Option<(u64, u64)> {
    let (tag, cert, _) = tlv(der)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, tbs, _) = tlv(cert)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    let (tag, _, after) = tlv(rest)?;
    if tag == 0xa0 {
        rest = after; // [0] version
    }
    for want in [0x02, 0x30, 0x30] {
        let (tag, _, after) = tlv(rest)?;
        if tag != want {
            return None;
        }
        rest = after; // serial, signature algorithm, issuer
    }
    let (tag, validity, _) = tlv(rest)?;
    if tag != 0x30 {
        return None;
    }
    let (t1, a, after) = tlv(validity)?;
    let (t2, b, _) = tlv(after)?;
    Some((der_time(t1, a)?, der_time(t2, b)?))
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

/// UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) as Unix seconds.
fn der_time(tag: u8, b: &[u8]) -> Option<u64> {
    let s = std::str::from_utf8(b).ok()?;
    let digits = s.strip_suffix('Z')?;
    if !digits.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (y, rest) = match (tag, digits.len()) {
        (0x17, 12) => {
            let yy: i64 = digits[..2].parse().ok()?;
            (if yy >= 50 { 1900 + yy } else { 2000 + yy }, &digits[2..])
        }
        (0x18, 14) => (digits[..4].parse().ok()?, &digits[4..]),
        _ => return None,
    };
    let n = |i: usize| -> Option<i64> { rest.get(i..i + 2)?.parse().ok() };
    let (m, d, h, mi, se) = (n(0)?, n(2)?, n(4)?, n(6)?, n(8)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    u64::try_from(crate::util::days_from_civil(y, m, d) * 86_400 + h * 3600 + mi * 60 + se).ok()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::crypto::SigningKey;
    use crate::http::{Request, Response};
    use rcgen::{BasicConstraints, CertificateParams, CertificateRevocationListParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose, RevocationReason, RevokedCertParams, SanType, SerialNumber};
    use rustls::server::WebPkiClientVerifier;
    use rustls::{ServerConfig, ServerConnection};
    use serde_json::json;
    use std::io::{BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    pub const HUB_SEED: [u8; 32] = [11u8; 32];
    pub const DEVICE_SEED: [u8; 32] = [12u8; 32];

    /// A Hub local CA and what it signs (made with rcgen at test time).
    pub struct Pki {
        pub ca_key: KeyPair,
        pub ca_params: CertificateParams,
        pub ca_der: Vec<u8>,
    }

    impl Pki {
        pub fn new(name: &str) -> Pki {
            Pki::with_constraints(name, None)
        }

        /// A CA limited like the Hub local CA (RFC 5280 name constraints).
        pub fn with_constraints(name: &str, nc: Option<rcgen::NameConstraints>) -> Pki {
            let ca_key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
            let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
            p.distinguished_name.push(DnType::CommonName, name);
            p.name_constraints = nc;
            p.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
            p.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
            let ca = p.self_signed(&ca_key).unwrap();
            Pki { ca_der: ca.der().to_vec(), ca_key, ca_params: p }
        }

        fn issuer(&self) -> Issuer<'_, &KeyPair> {
            Issuer::from_params(&self.ca_params, &self.ca_key)
        }

        /// A server leaf for these names (serverAuth), with its key as PKCS#8 DER.
        pub fn leaf(&self, names: &[&str]) -> (Vec<u8>, Vec<u8>) {
            let key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
            let mut p = CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
            p.subject_alt_names = names.iter().map(|n| match n.parse::<std::net::IpAddr>() { Ok(ip) => SanType::IpAddress(ip), Err(_) => SanType::DnsName((*n).try_into().unwrap()) }).collect();
            p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            // A leaf's life, like the Hub's (90 days there; years here so the tests keep passing).
            p.not_before = rcgen::date_time_ymd(2026, 1, 1);
            p.not_after = rcgen::date_time_ymd(2036, 1, 1);
            let cert = p.signed_by(&key, &self.issuer()).unwrap();
            (cert.der().to_vec(), key.serialize_der())
        }

        /// A device certificate (clientAuth only, `urn:nova:device:<id>`) for an Ed25519 seed.
        pub fn device(&self, id: &str, seed: &[u8; 32], serial: u64) -> Vec<u8> {
            let key = KeyPair::try_from(ed25519_pkcs8(seed).as_slice()).unwrap();
            let mut p = CertificateParams::new(Vec::<String>::new()).unwrap();
            p.distinguished_name.push(DnType::CommonName, id);
            p.subject_alt_names = vec![SanType::URI(format!("urn:nova:device:{id}").try_into().unwrap())];
            p.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
            p.serial_number = Some(SerialNumber::from(serial));
            p.signed_by(&key, &self.issuer()).unwrap().der().to_vec()
        }

        pub fn crl(&self, revoked: &[u64]) -> Vec<u8> {
            let now = rcgen::date_time_ymd(2026, 1, 1);
            CertificateRevocationListParams {
                this_update: now,
                next_update: rcgen::date_time_ymd(2099, 1, 1),
                crl_number: SerialNumber::from(1u64),
                issuing_distribution_point: None,
                revoked_certs: revoked.iter().map(|s| RevokedCertParams { serial_number: SerialNumber::from(*s), revocation_time: now, reason_code: Some(RevocationReason::KeyCompromise), invalidity_date: None }).collect(),
                key_identifier_method: KeyIdMethod::Sha256,
            }
            .signed_by(&self.issuer())
            .unwrap()
            .der()
            .to_vec()
        }
    }

    /// The identity statement a Hub with `hub_seed` signs for `nonce`.
    pub fn statement(hub_seed: &[u8; 32], nonce: &str, certs: &[(&str, &[u8])]) -> Value {
        let key = SigningKey::from_seed(hub_seed);
        let pk = b64url_encode(&key.public_key());
        let mut s = json!({
            "v": 1,
            "nonce": nonce,
            "hubFingerprint": crate::install::fingerprint(&key.public_key()),
            "hubPublicKey": pk,
            "pinning": "required",
            "certificates": certs.iter().map(|(k, der)| json!({ "kind": k, "sha256": sha256_hex(der), "notAfter": "2099-01-01T00:00:00.000Z" })).collect::<Vec<_>>(),
            "issuedAt": "2026-10-17T00:00:00.000Z",
        });
        let sig = key.sign(statement_bytes(&s).unwrap().as_bytes());
        s["signature"] = json!(b64url_encode(&sig));
        s
    }

    pub fn hub_pin() -> String {
        crate::install::fingerprint(&SigningKey::from_seed(&HUB_SEED).public_key())
    }

    /// A TLS test Hub: serves `chain` with `key`, asks for (but does not require) a client
    /// certificate from `client_ca` with `crls`, answers the identity statement with what
    /// `answer` returns, and records which connections presented a certificate.
    pub struct TestHub {
        pub port: u16,
        pub connections: Arc<AtomicUsize>,
        pub with_cert: Arc<AtomicUsize>,
        pub statements: Arc<AtomicUsize>,
        /// Connections on which the client presented a certificate at all (handshake or not).
        pub presented: Arc<AtomicUsize>,
    }

    pub type Answer = Arc<dyn Fn(&str) -> Value + Send + Sync>;

    pub fn test_hub(chain: Vec<Vec<u8>>, key: Vec<u8>, client_ca: Option<(&[u8], Vec<Vec<u8>>)>, answer: Answer, handler: Arc<dyn Fn(Request, bool) -> Response + Send + Sync>) -> TestHub {
        let provider = provider();
        let builder = ServerConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().unwrap();
        let builder = match client_ca {
            Some((ca, crls)) => {
                let mut roots = RootCertStore::empty();
                roots.add(CertificateDer::from(ca.to_vec())).unwrap();
                let v = WebPkiClientVerifier::builder_with_provider(Arc::new(roots), provider)
                    .with_crls(crls.into_iter().map(rustls::pki_types::CertificateRevocationListDer::from))
                    .allow_unauthenticated()
                    .build()
                    .unwrap();
                builder.with_client_cert_verifier(v)
            }
            None => builder.with_no_client_auth(),
        };
        let config = Arc::new(builder.with_single_cert(chain.into_iter().map(CertificateDer::from).collect(), PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key))).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hub = TestHub { port, connections: Arc::new(AtomicUsize::new(0)), with_cert: Arc::new(AtomicUsize::new(0)), statements: Arc::new(AtomicUsize::new(0)), presented: Arc::new(AtomicUsize::new(0)) };
        let (conns, certs, stmts, shown) = (hub.connections.clone(), hub.with_cert.clone(), hub.statements.clone(), hub.presented.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let (config, answer, handler) = (config.clone(), answer.clone(), handler.clone());
                let (conns, certs, stmts, shown) = (conns.clone(), certs.clone(), stmts.clone(), shown.clone());
                std::thread::spawn(move || {
                    conns.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut tls = StreamOwned::new(ServerConnection::new(config).unwrap(), stream);
                    let mut counted = false;
                    let mut saw = |tls: &StreamOwned<ServerConnection, std::net::TcpStream>| {
                        if !counted && tls.conn.peer_certificates().is_some_and(|c| !c.is_empty()) {
                            counted = true;
                            shown.fetch_add(1, Ordering::SeqCst);
                        }
                    };
                    loop {
                        let mut reader = BufReader::new(&mut tls);
                        let got = crate::http::read_one_request(&mut reader, 1 << 20);
                        drop(reader);
                        saw(&tls);
                        let Ok(req) = got else { return };
                        let has_cert = tls.conn.peer_certificates().is_some_and(|c| !c.is_empty());
                        if has_cert && req.path != "/api/v1/trust/identity" {
                            certs.fetch_add(1, Ordering::SeqCst);
                        }
                        if req.path == "/api/v1/trust/identity" {
                            stmts.fetch_add(1, Ordering::SeqCst);
                            let nonce = req.query.strip_prefix("nonce=").unwrap_or_default().to_string();
                            let mut r = Response::json(200, &answer(&nonce));
                            r.headers.push(("connection".into(), "keep-alive".into()));
                            if crate::http::write_one_response(&mut tls, &r, true).is_err() {
                                return;
                            }
                            continue;
                        }
                        let r = handler(req, has_cert);
                        let _ = crate::http::write_one_response(&mut tls, &r, false);
                        tls.conn.send_close_notify();
                        let _ = tls.flush();
                        return;
                    }
                });
            }
        });
        hub
    }

    pub fn hello(_: Request, has_cert: bool) -> Response {
        Response::json(200, &json!({ "name": "nova-hub", "clientCertificate": has_cert }))
    }

    fn get(ctx: &TlsContext, port: u16, path: &str) -> Result<(u16, Value), String> {
        crate::http::get_json_with(&format!("https://127.0.0.1:{port}{path}"), None, Duration::from_secs(5), Some(ctx))
    }

    #[test]
    fn statement_bytes_match_the_hub() {
        // The exact text @nova/shared `hubIdentityStatementBytes` produces for these fields.
        let s = json!({
            "signature": "x", "issuedAt": "2026-10-17T00:00:00.000Z", "certificates": [{ "notAfter": "N", "sha256": "ab", "kind": "ca" }],
            "pinning": "required", "hubPublicKey": "K", "hubFingerprint": "F", "nonce": "n0", "v": 1,
        });
        assert_eq!(
            statement_bytes(&s).unwrap(),
            "nova-hub-identity-v1\n{\"v\":1,\"nonce\":\"n0\",\"hubFingerprint\":\"F\",\"hubPublicKey\":\"K\",\"pinning\":\"required\",\"certificates\":[{\"kind\":\"ca\",\"sha256\":\"ab\",\"notAfter\":\"N\"}],\"issuedAt\":\"2026-10-17T00:00:00.000Z\"}"
        );
        assert!(statement_bytes(&json!({ "v": 1 })).is_none());
    }

    #[test]
    fn reads_certificate_validity() {
        let pki = Pki::new("Nova Hub CA");
        let (leaf, _) = pki.leaf(&["127.0.0.1"]);
        let (from, to) = validity(&leaf).unwrap();
        assert!(from < to);
        assert!(valid_at(&leaf, from + 1) && !valid_at(&leaf, to + 1) && !valid_at(&leaf, from - 1));
        assert!(validity(b"\x30\x03\x02\x01\x01").is_none());
        assert_eq!(der_time(0x17, b"491231235959Z"), Some(2524607999));
        assert_eq!(der_time(0x17, b"500101000000Z"), None, "1950 is before the epoch");
        assert_eq!(der_time(0x18, b"20991231235959Z").map(|t| t > 4_000_000_000), Some(true));
        assert!(der_time(0x18, b"2099123123595Z").is_none());
        assert_eq!(pem_certificates(&pem_certificate(&leaf)), vec![leaf]);
    }

    #[test]
    fn trusts_the_hub_through_its_signed_statement_and_caches_the_ca() {
        let pki = Pki::new("Nova Hub CA");
        let (leaf, key) = pki.leaf(&["127.0.0.1", "localhost"]);
        let (ca, l) = (pki.ca_der.clone(), leaf.clone());
        let hub = test_hub(vec![leaf.clone(), ca.clone()], key, None, Arc::new(move |n| statement(&HUB_SEED, n, &[("ca", &ca), ("leaf", &l)])), Arc::new(hello));
        let dir = crate::grants::tests::tmp("tls-good");
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join(TRUST_FILE);
        let ctx = TlsContext::new(HubTrust::pinned(&hub_pin())).with_store(store.clone());
        let (status, body) = get(&ctx, hub.port, "/api/v1/hello").unwrap();
        assert_eq!((status, body["name"].as_str()), (200, Some("nova-hub")));
        assert_eq!(hub.statements.load(Ordering::SeqCst), 1, "checked once, on the connection itself");
        let saved = HubTrust::load(&store).unwrap();
        assert_eq!(saved.ca_pem.as_deref().map(pem_certificates), Some(vec![pki.ca_der.clone()]));
        assert_eq!(saved.listed[0].sha256, sha256_hex(&leaf));
        // The next connection is trusted from the cache: no statement.
        get(&ctx, hub.port, "/api/v1/hello").unwrap();
        assert_eq!(hub.statements.load(Ordering::SeqCst), 1);
        // A new context from the saved file trusts the CA alone (a renewed leaf it issued).
        let only_ca = HubTrust { listed: vec![], ..saved };
        get(&TlsContext::new(only_ca), hub.port, "/api/v1/hello").unwrap();
        assert_eq!(hub.statements.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_certificate_from_another_ca_even_with_the_real_statement() {
        let real = Pki::new("Nova Hub CA");
        let (real_leaf, _) = real.leaf(&["127.0.0.1"]);
        let other = Pki::new("Someone else");
        let (leaf, key) = other.leaf(&["127.0.0.1"]);
        // The party in the middle relays the Hub's genuine, signed statement.
        let (ca, l) = (real.ca_der.clone(), real_leaf.clone());
        let hub = test_hub(vec![leaf, other.ca_der.clone()], key, None, Arc::new(move |n| statement(&HUB_SEED, n, &[("ca", &ca), ("leaf", &l)])), Arc::new(hello));
        let err = get(&TlsContext::new(HubTrust::pinned(&hub_pin())), hub.port, "/api/v1/hello").unwrap_err();
        assert!(err.contains("This is not your Hub") && err.contains("not_listed"), "{err}");
        // A device that already trusts the real CA refuses it the same way.
        let trusting = HubTrust { ca_pem: Some(pem_certificate(&real.ca_der)), ..HubTrust::pinned(&hub_pin()) };
        let err = get(&TlsContext::new(trusting), hub.port, "/api/v1/hello").unwrap_err();
        assert!(err.contains("not_listed"), "{err}");
        // Without a pin nothing can vouch for it.
        let err = get(&TlsContext::new(HubTrust::default()), hub.port, "/api/v1/hello").unwrap_err();
        assert!(err.contains("not trusted") || err.contains("UnknownIssuer"), "{err}");
    }

    #[test]
    fn refuses_a_statement_from_another_identity_or_for_another_nonce() {
        let pki = Pki::new("Nova Hub CA");
        let (leaf, key) = pki.leaf(&["127.0.0.1"]);
        let (ca, l) = (pki.ca_der.clone(), leaf.clone());
        let hub = test_hub(vec![leaf.clone(), ca.clone()], key.clone(), None, Arc::new(move |n| statement(&[99u8; 32], n, &[("ca", &ca), ("leaf", &l)])), Arc::new(hello));
        let err = get(&TlsContext::new(HubTrust::pinned(&hub_pin())), hub.port, "/api/v1/hello").unwrap_err();
        assert!(err.contains("pin_mismatch"), "{err}");
        let (ca, l) = (pki.ca_der.clone(), leaf.clone());
        let replay = test_hub(vec![leaf, pki.ca_der.clone()], key, None, Arc::new(move |_| statement(&HUB_SEED, "an-old-nonce-from-yesterday", &[("ca", &ca), ("leaf", &l)])), Arc::new(hello));
        let err = get(&TlsContext::new(HubTrust::pinned(&hub_pin())), replay.port, "/api/v1/hello").unwrap_err();
        assert!(err.contains("nonce_mismatch"), "{err}");
        // A tampered statement: the signature no longer verifies.
        let mut s = statement(&HUB_SEED, "nonce-nonce-nonce-1", &[("ca", &pki.ca_der)]);
        s["pinning"] = json!("off");
        assert_eq!(check_signed(&s, &hub_pin(), "nonce-nonce-nonce-1"), Err(Refusal::BadSignature));
    }

    #[test]
    fn holds_the_hub_ca_to_its_name_constraints() {
        use rcgen::{CidrSubnet, GeneralSubtree, NameConstraints};
        let pki = Pki::with_constraints(
            "Nova Hub CA",
            Some(NameConstraints {
                permitted_subtrees: vec![GeneralSubtree::DnsName("local".into()), GeneralSubtree::IpAddress(CidrSubnet::V4([127, 0, 0, 0], [255, 0, 0, 0]))],
                excluded_subtrees: vec![],
            }),
        );
        let now = crate::util::now_ms() / 1000;
        let s = statement(&HUB_SEED, "n", &[("ca", &pki.ca_der)]);
        let (inside, _) = pki.leaf(&["127.0.0.1", "hub.local"]);
        let (outside, _) = pki.leaf(&["127.0.0.1", "bank.example.com"]);
        let (far, _) = pki.leaf(&["192.0.2.7"]);
        assert!(check_chain(&s, "127.0.0.1", &[inside, pki.ca_der.clone()], now).is_ok());
        assert_eq!(check_chain(&s, "127.0.0.1", &[outside, pki.ca_der.clone()], now), Err(Refusal::NotListed));
        assert_eq!(check_chain(&s, "192.0.2.7", &[far, pki.ca_der.clone()], now), Err(Refusal::NotListed));
    }

    #[test]
    fn checks_chains_like_the_hub_reference() {
        let pki = Pki::new("Nova Hub CA");
        let (leaf, _) = pki.leaf(&["hub.local"]);
        let now = crate::util::now_ms() / 1000;
        let s = statement(&HUB_SEED, "n", &[("ca", &pki.ca_der)]);
        let chain = vec![leaf.clone(), pki.ca_der.clone()];
        assert_eq!(check_chain(&s, "hub.local", &chain, now), Ok(Some(pki.ca_der.clone())));
        assert_eq!(check_chain(&s, "other.local", &chain, now), Err(Refusal::HostMismatch));
        assert_eq!(check_chain(&s, "hub.local", &chain, now + 20 * 86_400 * 365), Err(Refusal::Expired));
        assert_eq!(check_chain(&s, "hub.local", &chain, 1_700_000_000), Err(Refusal::Expired), "not yet valid");
        assert_eq!(check_chain(&s, "hub.local", &[leaf.clone()], now), Err(Refusal::NotListed), "the CA must be in the chain");
        assert_eq!(check_chain(&s, "hub.local", &[], now), Err(Refusal::NoCertificate));
        // A device certificate from the same CA is client-only: never a server.
        let device = pki.device("dev-1", &DEVICE_SEED, 7);
        assert_eq!(check_chain(&s, "hub.local", &[device, pki.ca_der.clone()], now), Err(Refusal::NotServerCertificate));
        // The CA itself shown as the leaf is not a server certificate either.
        let listed_leaf = statement(&HUB_SEED, "n", &[("leaf", &leaf)]);
        assert_eq!(check_chain(&listed_leaf, "anything", &[leaf], now), Ok(None));
        assert_eq!(check_chain(&s, "hub.local", &[pki.ca_der.clone(), pki.ca_der.clone()], now), Err(Refusal::NotServerCertificate));
    }

    #[test]
    fn presents_the_device_certificate_and_names_a_revoked_one() {
        let pki = Pki::new("Nova Hub CA");
        let (leaf, key) = pki.leaf(&["127.0.0.1"]);
        let device = pki.device("dev-1", &DEVICE_SEED, 7);
        let trust = HubTrust { ca_pem: Some(pem_certificate(&pki.ca_der)), ..HubTrust::pinned(&hub_pin()) };
        let (ca, l) = (pki.ca_der.clone(), leaf.clone());
        let answer: Answer = Arc::new(move |n| statement(&HUB_SEED, n, &[("ca", &ca), ("leaf", &l)]));
        let hub = test_hub(vec![leaf.clone(), pki.ca_der.clone()], key.clone(), Some((&pki.ca_der, vec![pki.crl(&[99])])), answer.clone(), Arc::new(hello));
        let ctx = TlsContext::new(trust.clone()).with_client(Some(ClientCert::new(&pem_certificate(&device), &DEVICE_SEED).unwrap()));
        let (_, body) = get(&ctx, hub.port, "/api/v1/hello").unwrap();
        assert_eq!(body["clientCertificate"], true);
        assert_eq!(hub.with_cert.load(Ordering::SeqCst), 1);
        assert_eq!(hub.presented.load(Ordering::SeqCst), 1, "the test Hub sees a certificate that is sent");
        // Without a cached trust the provisional connection names nobody; the next one does.
        let fresh = TlsContext::new(HubTrust::pinned(&hub_pin())).with_client(Some(ClientCert::new(&pem_certificate(&device), &DEVICE_SEED).unwrap()));
        let (_, body) = get(&fresh, hub.port, "/api/v1/hello").unwrap();
        assert_eq!(body["clientCertificate"], true);
        assert_eq!(hub.statements.load(Ordering::SeqCst), 1);
        assert_eq!(hub.connections.load(Ordering::SeqCst), 3);
        // A Hub that revoked the certificate refuses the handshake: the error says so.
        let revoked = test_hub(vec![leaf, pki.ca_der.clone()], key, Some((&pki.ca_der, vec![pki.crl(&[7])])), answer, Arc::new(hello));
        let ctx = TlsContext::new(trust).with_client(Some(ClientCert::new(&pem_certificate(&device), &DEVICE_SEED).unwrap()));
        let err = get(&ctx, revoked.port, "/api/v1/hello").unwrap_err();
        assert!(err.contains("revoked"), "{err}");
        // A certificate for another key cannot be used with this seed.
        assert!(ClientCert::new("not pem", &DEVICE_SEED).is_err());
        assert!(ClientCert::new(&pem_certificate(&device), &[13u8; 32]).unwrap_err().contains("does not match"));
    }

    #[test]
    fn never_shows_the_device_certificate_to_an_unverified_server() {
        // The device trusts the real Hub CA (cached) and holds its certificate; on the Hub's
        // address sits another server, asking for client certificates of that same CA.
        let real = Pki::new("Nova Hub CA");
        let (real_leaf, _) = real.leaf(&["127.0.0.1"]);
        let other = Pki::new("Someone else");
        let (leaf, key) = other.leaf(&["127.0.0.1"]);
        let device = real.device("dev-1", &DEVICE_SEED, 7);
        let (ca, l) = (real.ca_der.clone(), real_leaf.clone());
        let impostor = test_hub(
            vec![leaf, other.ca_der.clone()],
            key,
            Some((&real.ca_der, vec![])),
            Arc::new(move |n| statement(&HUB_SEED, n, &[("ca", &ca), ("leaf", &l)])),
            Arc::new(hello),
        );
        for trust in [
            HubTrust { ca_pem: Some(pem_certificate(&real.ca_der)), ..HubTrust::pinned(&hub_pin()) },
            HubTrust { listed: vec![Listed { sha256: sha256_hex(&real_leaf), not_after: "2099-01-01T00:00:00Z".into() }], ..HubTrust::pinned(&hub_pin()) },
        ] {
            let ctx = TlsContext::new(trust).with_client(Some(ClientCert::new(&pem_certificate(&device), &DEVICE_SEED).unwrap()));
            for _ in 0..3 {
                let err = get(&ctx, impostor.port, "/api/v1/hello").unwrap_err();
                assert!(err.contains("not_listed"), "{err}");
            }
        }
        assert!(impostor.connections.load(Ordering::SeqCst) >= 12);
        assert_eq!(impostor.presented.load(Ordering::SeqCst), 0, "the device certificate never reached it");
    }

    #[test]
    fn learns_the_ca_over_plain_http_from_the_signed_statement() {
        let pki = Pki::new("Nova Hub CA");
        let ca = pki.ca_der.clone();
        let tamper = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let t = tamper.clone();
        let server = crate::http::serve(
            TcpListener::bind("127.0.0.1:0").unwrap(),
            1 << 20,
            Arc::new(move |req: Request| match req.path.as_str() {
                "/api/v1/trust/identity" => Response::json(200, &statement(&HUB_SEED, req.query.strip_prefix("nonce=").unwrap_or_default(), &[("ca", &ca)])),
                "/api/v1/trust/ca.pem" => {
                    let der = if t.load(Ordering::SeqCst) { Pki::new("x").ca_der } else { ca.clone() };
                    Response { status: 200, headers: vec![], body: pem_certificate(&der).into_bytes() }
                }
                _ => Response::error(404, "not_found", "no", None),
            }),
        );
        let hub = format!("http://{}", server.local_addr());
        let ctx = TlsContext::new(HubTrust::pinned(&hub_pin()));
        assert_eq!(learn_ca_over_http(&hub, &ctx, Duration::from_secs(5)), Ok(true));
        assert_eq!(ctx.trust().ca_der(), Some(pki.ca_der.clone()));
        tamper.store(true, Ordering::SeqCst);
        let ctx = TlsContext::new(HubTrust::pinned(&hub_pin()));
        assert!(learn_ca_over_http(&hub, &ctx, Duration::from_secs(5)).unwrap_err().contains("does not match"));
        let wrong = TlsContext::new(HubTrust::pinned(&crate::install::fingerprint(&[1u8; 32])));
        assert!(learn_ca_over_http(&hub, &wrong, Duration::from_secs(5)).unwrap_err().contains("pin_mismatch"));
        server.stop();
    }
}
