"""Tenant scoping for sub-project 1.

Single-tenant for v1; multi-tenant deferred. This constant is the only place
the bridge encodes its tenant identity — change here when multi-tenant lands.
"""

DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"
