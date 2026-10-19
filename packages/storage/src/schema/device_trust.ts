// M7 device_trust (FR-126): no tables. Mutual TLS state (what each device last presented over
// HTTPS) is kept in memory by the Hub's device-trust area and rebuilt by the next heartbeat;
// refusals go to the audit log. Migration 0039_device_trust.sql holds only a comment.
export {};
