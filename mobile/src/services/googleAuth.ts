import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import {
  GOOGLE_AUTH_URL,
  GOOGLE_HEALTH_SCOPES,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleHealthClient,
  GoogleHealthProvider,
  TokenManager,
  exchangeCode,
  revokeToken,
  systemClock,
  type Clock,
  type TokenSet,
  type TokenStore,
} from '@fitbit-air-tracker/core';

/**
 * Google sign-in on the phone: OAuth 2.0 + PKCE through the system browser
 * (expo-auth-session), tokens in the iOS Keychain (SecureStore). Uses an
 * **iOS** OAuth client (no secret). The redirect scheme must be the reversed
 * client ID — app.config.js registers it from EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.
 */

WebBrowser.maybeCompleteAuthSession();

const TOKEN_KEY = 'google_health_tokens';

export const DEFAULT_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';

export const secureTokenStore: TokenStore = {
  async load(): Promise<TokenSet | undefined> {
    const raw = await SecureStore.getItemAsync(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : undefined;
  },
  async save(tokens: TokenSet): Promise<void> {
    await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
  },
  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  },
};

export function reversedClientId(clientId: string): string {
  return `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/, '')}`;
}

export function redirectUriFor(clientId: string): string {
  return `${reversedClientId(clientId)}:/oauthredirect`;
}

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: GOOGLE_AUTH_URL,
  tokenEndpoint: GOOGLE_TOKEN_URL,
  revocationEndpoint: GOOGLE_REVOKE_URL,
};

/** Opens Google sign-in; resolves once tokens are stored. Throws on cancel/error. */
export async function signInWithGoogle(clientId: string): Promise<TokenSet> {
  const id = clientId.trim();
  if (!id) throw new Error('Enter the iOS OAuth client ID first (docs/GOOGLE_HEALTH_API.md §1).');
  const redirectUri = redirectUriFor(id);
  const request = new AuthSession.AuthRequest({
    clientId: id,
    redirectUri,
    scopes: GOOGLE_HEALTH_SCOPES,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: { access_type: 'offline', prompt: 'consent' },
  });
  await request.makeAuthUrlAsync(discovery);
  const result = await request.promptAsync(discovery);
  if (result.type !== 'success') {
    const reason = result.type === 'error' ? (result.error?.description ?? result.params?.error ?? 'error') : result.type;
    throw new Error(`Google sign-in ${reason}`);
  }
  const tokens = await exchangeCode({
    clientId: id,
    code: result.params.code!,
    codeVerifier: request.codeVerifier!,
    redirectUri,
  });
  await secureTokenStore.save(tokens);
  return tokens;
}

export async function signOutOfGoogle(): Promise<void> {
  const tokens = await secureTokenStore.load();
  if (tokens?.refreshToken) await revokeToken(tokens.refreshToken);
  await secureTokenStore.clear();
}

export async function isGoogleConnected(): Promise<boolean> {
  return Boolean(await secureTokenStore.load());
}

export function makeGoogleProvider(clientId: string, clock: Clock = systemClock): GoogleHealthProvider {
  const tokenManager = new TokenManager({ store: secureTokenStore, clientId: clientId.trim(), clock });
  const client = new GoogleHealthClient({
    getAccessToken: tokenManager.getAccessToken,
    onUnauthorized: () => tokenManager.forceRefresh(),
  });
  return new GoogleHealthProvider({ client, clock });
}
