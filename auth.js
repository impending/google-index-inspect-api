// Unattended auth: exchange a refresh token for an access token.
// Used when GSC_CLIENT_ID, GSC_CLIENT_SECRET and GSC_REFRESH_TOKEN are set.
export function hasRefreshEnv(env = process.env) {
  return Boolean(env.GSC_CLIENT_ID && env.GSC_CLIENT_SECRET && env.GSC_REFRESH_TOKEN);
}

export async function refreshTokenCredentials(env = process.env, fetchImpl = fetch) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GSC_CLIENT_ID,
      client_secret: env.GSC_CLIENT_SECRET,
      refresh_token: env.GSC_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`token exchange failed: HTTP ${res.status} ${j.error || ''}`);
  return { access_token: j.access_token };
}
