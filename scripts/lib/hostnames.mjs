// Single source of truth for hostnames used by release/certification scripts.
// A domain move is a configuration change: set OCI_PUBLIC_HOSTNAME (and, for the drill stack,
// OCI_STAGING_HOSTNAME) in the environment. The fallback below is the current value and is
// the only place it lives in code.
const CURRENT_PRODUCTION_HOSTNAME = "matchday.poladex.shop";

export function productionHostname(env = process.env) {
  const configured = env.OCI_PUBLIC_HOSTNAME?.trim().toLowerCase();
  return configured || CURRENT_PRODUCTION_HOSTNAME;
}

export function productionOrigin(env = process.env) {
  return `https://${productionHostname(env)}`;
}
