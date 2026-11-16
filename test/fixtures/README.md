`proxy-cert.pem` and `proxy-key.pem` are public, self-signed test fixtures for the
local HTTPS CONNECT regression test. They identify `unresolvable.invalid` and
must never be used outside tests. The test trusts this certificate only in its
isolated child process; application TLS verification stays enabled.
