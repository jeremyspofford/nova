//! Local MCP pass-through (FR-210, docs/23 §4.1): the device's own stdio MCP servers, declared by
//! the device owner in novad's config, can be listed and called by Hub sessions that hold an `mcp`
//! grant for the server. Each call starts the server (sandboxed when the device has a sandbox),
//! initializes it, makes one request and stops it. Since M8 the same grant also lists and reads
//! the server's resources and prompts (`request`, five read-only methods). Output is untrusted;
//! the Hub runs every call through its policy engine and audit (FR-189).

use crate::exec::{find_bwrap, kill_group};
use crate::grants::{GrantStore, Grantee};
use crate::hardening::{Limits, harden_command};
use crate::util::{OpError, OpResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "2025-06-18";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LINE: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Run under the sandbox (default). The device owner may turn it off for one server in the
    /// local config only; the Hub cannot.
    #[serde(default = "yes")]
    pub sandbox: bool,
}

fn yes() -> bool {
    true
}

/// One JSON-RPC exchange session with a started server.
struct Session {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<String>,
    next: u64,
}

impl Session {
    fn start(server: &McpServer) -> OpResult<Session> {
        let mut cmd = if server.sandbox {
            let bwrap = find_bwrap()
                .ok_or_else(|| OpError::new(409, "sandbox_unavailable", "no sandbox on this device for MCP servers"))?;
            let mut c = Command::new(bwrap);
            c.args(["--unshare-all", "--share-net", "--die-with-parent", "--new-session"]);
            for sys in ["/usr", "/bin", "/lib", "/lib64", "/etc"] {
                c.args(["--ro-bind-try", sys, sys]);
            }
            c.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
            if let Some(cwd) = &server.cwd {
                c.args(["--ro-bind", cwd, cwd, "--chdir", cwd]);
            }
            c.arg("--").arg(&server.command).args(&server.args);
            c
        } else {
            let mut c = Command::new(&server.command);
            c.args(&server.args);
            if let Some(cwd) = &server.cwd {
                c.current_dir(cwd);
            }
            c
        };
        let env: Vec<(String, String)> = server.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        harden_command(&mut cmd, &env, Limits::default());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| OpError::unavailable(format!("the MCP server {} did not start: {e}", server.name)))?;
        let stdin = child.stdin.take().ok_or_else(|| OpError::internal("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| OpError::internal("no stdout"))?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match r.by_ref().take(MAX_LINE as u64).read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Ok(Session { child, stdin, lines: rx, next: 1 })
    }

    fn send(&mut self, msg: &Value) -> OpResult<()> {
        let mut s = serde_json::to_string(msg).map_err(|e| OpError::internal(e.to_string()))?;
        s.push('\n');
        self.stdin.write_all(s.as_bytes()).map_err(|e| OpError::unavailable(format!("the MCP server closed: {e}")))
    }

    /// Send a request and wait for its response; server requests are refused, notifications skipped.
    fn request(&mut self, method: &str, params: Value, deadline: Instant) -> OpResult<Value> {
        let id = self.next;
        self.next += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(OpError::new(504, "server_error", "the MCP server did not answer in time"));
            }
            let line = self.lines.recv_timeout(left).map_err(|_| OpError::unavailable("the MCP server stopped answering"))?;
            let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
            if msg.get("method").is_some() {
                if let Some(rid) = msg.get("id") {
                    self.send(&json!({ "jsonrpc": "2.0", "id": rid, "error": { "code": -32601, "message": "not supported" } }))?;
                }
                continue;
            }
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(OpError::new(502, "server_error", format!("MCP error: {}", err["message"].as_str().unwrap_or("unknown")))
                    .with(json!({ "reason": "mcp_error", "mcpCode": err["code"] })));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn initialize(&mut self, deadline: Instant) -> OpResult<()> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "novad", "version": env!("CARGO_PKG_VERSION") }
            }),
            deadline,
        )?;
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        kill_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn find<'a>(servers: &'a [McpServer], name: &str) -> OpResult<&'a McpServer> {
    servers.iter().find(|s| s.name == name).ok_or_else(|| OpError::not_found(format!("no local MCP server named {name}")))
}

/// The servers granted to `grantee`, each with its tools (a server that fails is listed with an
/// error instead of failing the whole list).
pub fn list(servers: &[McpServer], grants: &GrantStore, grantee: &Grantee) -> OpResult<Value> {
    let mut out = vec![];
    for s in servers {
        if !grants.mcp_allowed(grantee, &s.name)? {
            continue;
        }
        match tools_of(s) {
            Ok(tools) => out.push(json!({ "name": s.name, "tools": tools })),
            Err(e) => out.push(json!({ "name": s.name, "tools": [], "error": e.to_json() })),
        }
    }
    Ok(json!({ "servers": out }))
}

fn tools_of(server: &McpServer) -> OpResult<Vec<Value>> {
    let deadline = Instant::now() + CALL_TIMEOUT;
    let mut s = Session::start(server)?;
    s.initialize(deadline)?;
    let mut tools = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let r = s.request("tools/list", params, deadline)?;
        if let Some(list) = r["tools"].as_array() {
            tools.extend(list.iter().map(|t| {
                json!({ "name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"] })
            }));
        }
        cursor = r["nextCursor"].as_str().map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

/// Call one tool on a granted server.
pub fn call(servers: &[McpServer], grants: &GrantStore, grantee: &Grantee, server: &str, tool: &str, arguments: Value) -> OpResult<Value> {
    let srv = find(servers, server)?;
    if !grants.mcp_allowed(grantee, server)? {
        return Err(OpError::denied("mcp_grant_required", format!("the MCP server {server} is not granted to this session")));
    }
    if tool.is_empty() || tool.len() > 200 {
        return Err(OpError::validation("tool is required"));
    }
    let deadline = Instant::now() + CALL_TIMEOUT;
    let mut s = Session::start(srv)?;
    s.initialize(deadline)?;
    let r = s.request("tools/call", json!({ "name": tool, "arguments": arguments }), deadline)?;
    Ok(json!({ "content": r.get("content").cloned().unwrap_or(json!([])), "isError": r["isError"].as_bool().unwrap_or(false), "untrusted": true }))
}

/// The read-only methods besides tools that a granted session may pass to a server (M8, FR-042):
/// listing and reading resources and prompts. Anything else is refused.
pub const PASS_METHODS: [&str; 5] = ["resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get"];

/// One resources or prompts request to a granted server: its result as the server answered it.
pub fn request(servers: &[McpServer], grants: &GrantStore, grantee: &Grantee, server: &str, method: &str, params: Value) -> OpResult<Value> {
    let srv = find(servers, server)?;
    if !grants.mcp_allowed(grantee, server)? {
        return Err(OpError::denied("mcp_grant_required", format!("the MCP server {server} is not granted to this session")));
    }
    if !PASS_METHODS.contains(&method) {
        return Err(OpError::validation(format!("{method} cannot be passed to a device's MCP server")));
    }
    let params = if params.is_object() { params } else { json!({}) };
    let deadline = Instant::now() + CALL_TIMEOUT;
    let mut s = Session::start(srv)?;
    s.initialize(deadline)?;
    let r = s.request(method, params, deadline)?;
    Ok(json!({ "result": r, "untrusted": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grants::tests::tmp;

    /// A tiny stdio MCP server in POSIX sh: answers initialize (id 1), tools/list and tools/call
    /// (id 2) with canned results.
    const SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}' ;;
    *'"method":"tools/list"'*) echo '{"jsonrpc":"2.0","method":"notifications/message","params":{}}'; echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echo","inputSchema":{"type":"object"}}]}}' ;;
    *'"method":"tools/call"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"echoed"}]}}' ;;
    *'"method":"resources/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"resources":[{"uri":"note://a","name":"a"}]}}' ;;
    *'"method":"prompts/get"'*) echo '{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no prompts"}}' ;;
  esac
done
"#;

    fn server(dir: &std::path::Path) -> McpServer {
        let p = dir.join("srv.sh");
        std::fs::write(&p, SERVER).unwrap();
        McpServer { name: "notes".into(), command: "/bin/sh".into(), args: vec![p.to_string_lossy().to_string()], env: Default::default(), cwd: None, sandbox: false }
    }

    #[test]
    fn lists_and_calls_granted_servers_only() {
        let base = tmp("mcp");
        let store = GrantStore::new(base.join("grants.json"), base.join("data"));
        let g = Grantee { kind: "agent".into(), id: "a".into() };
        let servers = vec![server(&base)];
        assert_eq!(list(&servers, &store, &g).unwrap()["servers"], json!([]));
        assert_eq!(call(&servers, &store, &g, "notes", "echo", json!({})).unwrap_err().details.unwrap()["reason"], "mcp_grant_required");
        store.grant(&g, "mcp", "notes", "call", "hub").unwrap();
        let l = list(&servers, &store, &g).unwrap();
        assert_eq!(l["servers"][0]["tools"][0]["name"], "echo");
        let c = call(&servers, &store, &g, "notes", "echo", json!({"x": 1})).unwrap();
        assert_eq!(c["content"][0]["text"], "echoed");
        assert_eq!(c["untrusted"], true);
        assert_eq!(call(&servers, &store, &g, "missing", "echo", json!({})).unwrap_err().code, "not_found");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn passes_resources_and_prompts_to_granted_servers_only() {
        let base = tmp("mcp3");
        let store = GrantStore::new(base.join("grants.json"), base.join("data"));
        let g = Grantee { kind: "user".into(), id: "u".into() };
        let servers = vec![server(&base)];
        let denied = request(&servers, &store, &g, "notes", "resources/list", json!({})).unwrap_err();
        assert_eq!(denied.details.unwrap()["reason"], "mcp_grant_required");
        store.grant(&g, "mcp", "notes", "call", "hub").unwrap();
        let r = request(&servers, &store, &g, "notes", "resources/list", json!({})).unwrap();
        assert_eq!(r["result"]["resources"][0]["uri"], "note://a");
        assert_eq!(r["untrusted"], true);
        // Only the read-only methods pass; a server's own error comes back as one.
        assert_eq!(request(&servers, &store, &g, "notes", "tools/call", json!({})).unwrap_err().code, "validation");
        assert_eq!(request(&servers, &store, &g, "notes", "initialize", json!({})).unwrap_err().code, "validation");
        let e = request(&servers, &store, &g, "notes", "prompts/get", json!({ "name": "x" })).unwrap_err();
        assert_eq!(e.details.unwrap()["reason"], "mcp_error");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_dead_server_is_reported_not_fatal() {
        let base = tmp("mcp2");
        let store = GrantStore::new(base.join("grants.json"), base.join("data"));
        let g = Grantee { kind: "agent".into(), id: "a".into() };
        let dead = McpServer { name: "dead".into(), command: "/bin/sh".into(), args: vec!["-c".into(), "exit 0".into()], env: Default::default(), cwd: None, sandbox: false };
        store.grant(&g, "mcp", "dead", "call", "hub").unwrap();
        let l = list(&[dead], &store, &g).unwrap();
        assert_eq!(l["servers"][0]["error"]["code"], "node_unavailable");
        std::fs::remove_dir_all(&base).unwrap();
    }
}
