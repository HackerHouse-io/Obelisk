// auth/session.ts — fixed version
export function getSameSite(secure) {
  // Safari requires SameSite=None when Secure is true; default to Lax otherwise.
  if (!secure) return 'Lax';
  return 'None';
}
