//! novad's data directory (docs/23 §2): the device identity and Hub credentials (`device.json` and
//! `key.seed`, mode 0600), the owner's local config (`config.json`), what the Hub pushed
//! (`hub-config.json`), the module manifest (`modules.json`) and the storage module's state.

use crate::crypto::{SigningKey, b64url_encode, random_bytes};
use crate::hardening::Limits;
use crate::mcp::McpServer;
use crate::util::{OpError, OpResult, new_id, read_json_or, write_atomic, write_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const CHANNELS: &[&str] = &["stable", "beta", "nightly"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceState {
    /// The device's own id in its capability documents (the Hub has its own id for it).
    pub local_device_id: String,
    pub name: String,
    pub roles: Vec<String>,
    #[serde(default)]
    pub hub_url: Option<String>,
    /// The Hub's id for this device.
    #[serde(default)]
    pub device_id: Option<String>,
    /// `nvc_…`: presented to the Hub on heartbeats and capability updates.
    #[serde(default)]
    pub credential: Option<String>,
    /// `nvm_…`: the Hub presents it on every management call to this device.
    #[serde(default)]
    pub management_token: Option<String>,
    #[serde(default)]
    pub listen: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default = "stable")]
    pub channel: String,
    /// Raw Ed25519 public key (base64url) that signs update bundles; pinned once (FR-148).
    #[serde(default)]
    pub update_trust_key: Option<String>,
    #[serde(default = "beat")]
    pub heartbeat_interval_ms: u64,
    #[serde(default)]
    pub enrolled_at: Option<String>,
    #[serde(default)]
    pub revoked: bool,
}

fn stable() -> String {
    "stable".into()
}

fn beat() -> u64 {
    10_000
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSpec {
    pub name: String,
    /// `module` (a supervised module) or `systemd` (a unit on this machine).
    pub kind: String,
    #[serde(default)]
    pub module: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PowerConfig {
    /// WoL changes may be applied (with elevation and an explicit apply).
    pub allow_changes: bool,
    /// Sleep, restart and shutdown may run.
    pub allow_actions: bool,
}

/// The device owner's settings. Only the owner edits this file; the Hub cannot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub capability_overrides: Value,
    pub services: Vec<ServiceSpec>,
    pub power: PowerConfig,
    pub mcp_servers: Vec<McpServer>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            capability_overrides: json!({}),
            services: vec![ServiceSpec { name: "compute".into(), kind: "module".into(), module: Some("compute".into()), unit: None }],
            power: PowerConfig::default(),
            mcp_servers: vec![],
        }
    }
}

/// Per-device policy from the Hub (FR-150).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DevicePolicy {
    pub allowed_modules: Option<Vec<String>>,
    pub resource_caps: Limits,
    pub quiet_hours: Vec<String>,
    pub routing_eligible: Option<bool>,
}

/// What the Hub pushed: capability overrides (FR-142) and policy (FR-150).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HubConfig {
    pub capability_overrides: Value,
    pub policy: DevicePolicy,
    /// The update channel the Hub set for this device (FR-148); None keeps the enrolled one.
    pub update_channel: Option<String>,
    pub revision: u64,
}

impl Default for HubConfig {
    fn default() -> Self {
        HubConfig { capability_overrides: json!({}), policy: DevicePolicy::default(), update_channel: None, revision: 0 }
    }
}

#[derive(Debug, Clone)]
pub struct DataDir(pub PathBuf);

impl DataDir {
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn device_path(&self) -> PathBuf {
        self.0.join("device.json")
    }
    pub fn seed_path(&self) -> PathBuf {
        self.0.join("key.seed")
    }
    pub fn config_path(&self) -> PathBuf {
        self.0.join("config.json")
    }
    pub fn hub_config_path(&self) -> PathBuf {
        self.0.join("hub-config.json")
    }
    pub fn manifest_path(&self) -> PathBuf {
        self.0.join("modules.json")
    }

    /// Create the folder, private to novad's user.
    pub fn ensure(&self) -> OpResult<()> {
        std::fs::create_dir_all(&self.0)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    pub fn device(&self) -> OpResult<Option<DeviceState>> {
        read_json_or(&self.device_path(), None).map_err(|e| OpError::internal(e.to_string()))
    }

    pub fn save_device(&self, d: &DeviceState) -> OpResult<()> {
        write_json(&self.device_path(), d, true).map_err(OpError::from)
    }

    pub fn config(&self) -> OpResult<Config> {
        read_json_or(&self.config_path(), Config::default()).map_err(|e| OpError::internal(e.to_string()))
    }

    pub fn hub_config(&self) -> OpResult<HubConfig> {
        read_json_or(&self.hub_config_path(), HubConfig::default()).map_err(|e| OpError::internal(e.to_string()))
    }

    pub fn save_hub_config(&self, c: &HubConfig) -> OpResult<()> {
        write_json(&self.hub_config_path(), c, false).map_err(OpError::from)
    }

    /// The device key, created on first use (32 random bytes, mode 0600).
    pub fn key(&self) -> OpResult<SigningKey> {
        let p = self.seed_path();
        match std::fs::read(&p) {
            Ok(b) if b.len() == 32 => {
                let mut seed = [0u8; 32];
                seed.copy_from_slice(&b);
                Ok(SigningKey::from_seed(&seed))
            }
            Ok(_) => Err(OpError::internal("key.seed is damaged")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut seed = [0u8; 32];
                random_bytes(&mut seed).map_err(OpError::internal)?;
                write_atomic(&p, &seed, true)?;
                Ok(SigningKey::from_seed(&seed))
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn public_key(&self) -> OpResult<String> {
        Ok(b64url_encode(&self.key()?.public_key()))
    }

    /// A fresh device state for enrollment (a new local id unless one exists).
    pub fn new_device(&self, name: &str, roles: Vec<String>) -> OpResult<DeviceState> {
        let existing = self.device()?;
        Ok(DeviceState {
            local_device_id: existing.map(|d| d.local_device_id).unwrap_or_else(new_id),
            name: name.into(),
            roles,
            hub_url: None,
            device_id: None,
            credential: None,
            management_token: None,
            listen: None,
            endpoint: None,
            channel: "stable".into(),
            update_trust_key: None,
            heartbeat_interval_ms: beat(),
            enrolled_at: None,
            revoked: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;

    #[test]
    fn keeps_a_private_key_and_state() {
        let base = tmp("state");
        let d = DataDir(base.join("data"));
        d.ensure().unwrap();
        let k1 = d.public_key().unwrap();
        assert_eq!(d.public_key().unwrap(), k1, "the key is stable");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(d.seed_path()).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(d.device().unwrap().is_none());
        let mut s = d.new_device("box", vec!["client".into()]).unwrap();
        s.credential = Some("nvc_x".into());
        d.save_device(&s).unwrap();
        assert_eq!(d.device().unwrap().unwrap(), s);
        assert_eq!(std::fs::metadata(d.device_path()).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(d.new_device("box", vec![]).unwrap().local_device_id, s.local_device_id);
        let c = d.config().unwrap();
        assert_eq!(c.services[0].name, "compute");
        assert_eq!(d.hub_config().unwrap().revision, 0);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
