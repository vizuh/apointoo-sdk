// Ambient module declarations for optional runtime deps that TS can't resolve
// at compile time. Adapters that use these load them via dynamic import in a
// try/catch + cast — the runtime is correct; the type system just needs to
// know the module name exists. See ADR-009 (RwG publisher) + ADR-014 (Recal).

declare module 'ssh2-sftp-client'
declare module 'recal-sdk'
