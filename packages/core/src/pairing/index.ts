// M6.5 Add Device (FR-132, FR-140; docs/22 §4): pairings with short codes, the confirmation both
// screens show, signed status polls, grants handed out once, revocation with blocked keys, and the
// seams the trust, agent-dist, network and relay areas fill. packages/core/src/index.ts re-exports it.
export {
  DEVICE_SESSION_DAYS,
  PAIRING_CODE_ONLY_GUESSES,
  PAIRING_CODE_ONLY_LOCK_MS,
  PAIRING_CODE_ONLY_WINDOW_MS,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_REVEAL_TTL_MS,
  PAIRING_STARTS_PER_HOUR,
  PAIRING_STATUS_SKEW_S,
  PairingService,
  type PairingCertIssuer,
  type PairingDecision,
  type PairingGrantContext,
  type PairingGrantIssuers,
  type PairingHubIdentity,
  type PairingRelayClaim,
  type PairingRelayOpener,
  type PairingServiceOptions,
  type PairingSettings,
  type PairingStarted,
  type PairingStartInput,
  type PairingStatusProof,
  type PairingStatusResult,
} from './service.ts';
export {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  displayPairingCode,
  hubRevealStatement,
  newPairingCode,
  newPairingNonce,
  normalizeConfirmation,
  normalizePairingCode,
  pairingCodeHash,
  pairingCommitment,
  pairingConfirmation,
  pairingConfirmationV2,
  revealMessage as pairingRevealMessage,
  statusMessage as pairingStatusMessage,
  verifyRevealSignature as verifyPairingRevealSignature,
  verifyStatusSignature as verifyPairingStatusSignature,
} from './code.ts';
export { SlidingWindowLimiter, type SlidingWindowLimiterOptions } from './limiter.ts';
export { enrollBindingOf, type EnrollKeyBinding } from './binding.ts';
