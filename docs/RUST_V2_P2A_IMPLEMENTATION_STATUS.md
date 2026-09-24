# P2A implementation status

Packet P2A is implemented for Linux and macOS Unix permission semantics. The
bundled provider/model catalog, credential store, setup operations, and
provider cache fail closed when a private filesystem boundary cannot be
verified.

Windows credential and catalog-cache persistence is intentionally fail-closed
in this packet: the current implementation does not yet establish or verify a
current-user-only ACL, so those operations return an insecure-permissions
error instead of writing. A later Windows platform packet must replace the
non-Unix permission stubs with `SetNamedSecurityInfo`/equivalent ACL
establishment and verification, plus the corresponding directory durability
primitive. No provider credential is persisted when that check fails.
