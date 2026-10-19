// secret-scan: fake-file (test publisher keys: one signs only the built-in sample catalog, whose
// public half packages/core/src/market pins for that catalog alone; the other signs the sample
// third-party extension. Neither is ever a built-in trusted publisher.)
// The built-in sample catalog's signing key (FR-049, ADR-097 D2) as PKCS#8 PEM, and its public
// key (base64url). Tests use it to check examples/catalog, and the signing script to re-sign it.
export const SAMPLE_CATALOG_TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIC1YcKMYf4bIQC/koNJgDq3KeO1rhkHuYeYOum1Dw3Cc
-----END PRIVATE KEY-----
`;
export const SAMPLE_CATALOG_TEST_PUBLIC_KEY = 'KlKjf0jPaUSFthkQWHASvMCUmtOx5U9Ff1Hm6ju42Ds';

/**
 * "Example Labs", the made-up third-party publisher of the sample `.novax` extension. Its private
 * half is public here, so Nova never trusts it by itself: the owner adds it to
 * `plugins.trustedPublishers` (as the tests do), or the extension installs Unverified.
 */
export const EXAMPLE_LABS_TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDXo1xRMB+Tj1N1jAmNEgVR0C8BzOLxnSH2lx6hFBpPL
-----END PRIVATE KEY-----
`;
export const EXAMPLE_LABS_PUBLIC_KEY = 'KWyGeoNcQVUoD7fIgkwppFWhQZbPo5ynx1JyVjt5-O0';
