import {
  Configuration,
  None,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch,
  discovery,
  randomPKCECodeVerifier,
  randomState,
  refreshTokenGrant,
} from "openid-client";

export type MaybePromise<T> = T | Promise<T>;

/** Production US Workato identity service. */
export const DEFAULT_IDENTITY_BASE_URL = "https://id.workato.com";

export interface Auth {
  headers(): MaybePromise<Record<string, string>>;
  forceRefresh?(): MaybePromise<void>;
}

export class ApiKeyAuth implements Auth {
  constructor(private readonly apiKey: string, private readonly idpUserId: string | (() => MaybePromise<string>)) {}

  async headers(): Promise<Record<string, string>> {
    const userId = typeof this.idpUserId === "function" ? await this.idpUserId() : this.idpUserId;
    return { Authorization: `Bearer ${this.apiKey}`, "X-IDP-User-Id": userId };
  }
}

export class OAuthAuth implements Auth {
  constructor(private readonly accessTokenProvider: () => MaybePromise<string>) {}

  async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.accessTokenProvider()}` };
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface OAuthPkceOptions {
  clientId: string;
  redirectUri: string;
  /** Use this for Preview or a custom Workato identity environment. */
  identityBaseUrl?: string;
  /** Optional injected fetch implementation, useful for tests and non-Node runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface OAuthAuthorizationRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}

/**
 * OAuth 2.0 Authorization Code + PKCE helper for a public Genie client.
 * Applications own the returned state, verifier, and tokens; no client secret is used.
 */
export class OAuthPkce {
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly identityBaseUrl: string;
  private readonly customFetch?: typeof globalThis.fetch;
  private configurationPromise?: Promise<Configuration>;

  constructor({ clientId, redirectUri, identityBaseUrl = DEFAULT_IDENTITY_BASE_URL, fetch }: OAuthPkceOptions) {
    this.clientId = clientId;
    this.redirectUri = redirectUri;
    this.identityBaseUrl = trimTrailingSlashes(identityBaseUrl);
    this.customFetch = fetch;
  }

  /**
   * The identity server's `issuer` claim can differ from identityBaseUrl (e.g. a Preview
   * environment issuing tokens under the production issuer), so endpoints and the issuer used
   * for ID token validation are discovered rather than assumed. Fetching the well-known URL
   * directly (instead of the bare base URL) skips openid-client's issuer===host consistency
   * check, since a mismatch here is Workato's intended shared-issuer-across-environments design.
   */
  private configuration(): Promise<Configuration> {
    if (!this.configurationPromise) {
      this.configurationPromise = discovery(
        new URL(`${this.identityBaseUrl}/.well-known/openid-configuration`),
        this.clientId,
        { redirect_uris: [this.redirectUri], token_endpoint_auth_method: "none" },
        None(),
        this.customFetch ? { [customFetch]: this.customFetch as never } : undefined,
      );
    }
    return this.configurationPromise;
  }

  async createAuthorizationRequest(): Promise<OAuthAuthorizationRequest> {
    const configuration = await this.configuration();
    const codeVerifier = randomPKCECodeVerifier();
    const state = randomState();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const authorizationUrl = buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: "openid profile",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { authorizationUrl: authorizationUrl.href, state, codeVerifier };
  }

  async exchangeCallback(callbackUrl: string | URL, request: Pick<OAuthAuthorizationRequest, "state" | "codeVerifier">): Promise<OAuthTokens> {
    const url = new URL(callbackUrl);
    if (url.searchParams.get("state") !== request.state) throw new Error("OAuth callback state does not match the login request");
    const configuration = await this.configuration();
    const response = await authorizationCodeGrant(configuration, url, {
      expectedState: request.state,
      pkceCodeVerifier: request.codeVerifier,
    });
    return this.tokensFrom(response);
  }

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    const configuration = await this.configuration();
    const response = await refreshTokenGrant(configuration, tokens.refreshToken);
    return this.tokensFrom(response, tokens.refreshToken);
  }

  refreshableAuth(loadTokens: () => MaybePromise<OAuthTokens>, persistTokens: (tokens: OAuthTokens) => MaybePromise<void>, refreshSkewMs = 60_000): RefreshableOAuthAuth {
    return new RefreshableOAuthAuth(loadTokens, async (current) => {
      const refreshed = await this.refresh(current);
      await persistTokens(refreshed);
      return refreshed;
    }, refreshSkewMs);
  }

  private tokensFrom(response: { access_token?: string; refresh_token?: string; expires_in?: number }, previousRefreshToken?: string): OAuthTokens {
    if (!response.access_token) throw new Error("OAuth token response did not include an access token");
    const refreshToken = response.refresh_token ?? previousRefreshToken;
    if (!refreshToken) throw new Error("OAuth token response did not include a refresh token");
    return { accessToken: response.access_token, refreshToken, expiresAt: new Date(Date.now() + (response.expires_in ?? 3600) * 1000) };
  }
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export class RefreshableOAuthAuth implements Auth {
  private refreshInFlight?: Promise<OAuthTokens>;

  constructor(
    private readonly loadTokens: () => MaybePromise<OAuthTokens>,
    /** Atomically refreshes rotating credentials and persists the winning token set. */
    private readonly refreshAndPersist: (current: OAuthTokens) => MaybePromise<OAuthTokens>,
    private readonly refreshSkewMs = 60_000
  ) {}

  async headers(): Promise<Record<string, string>> {
    const tokens = await this.loadTokens();
    const current = tokens.expiresAt.getTime() <= Date.now() + this.refreshSkewMs ? await this.refresh(tokens) : tokens;
    return { Authorization: `Bearer ${current.accessToken}` };
  }

  private async refresh(tokens: OAuthTokens, force = false): Promise<OAuthTokens> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        const latest = await this.loadTokens();
        if (!force && latest.expiresAt.getTime() > Date.now() + this.refreshSkewMs) return latest;
        return this.refreshAndPersist(latest);
      })().finally(() => { this.refreshInFlight = undefined; });
    }
    return this.refreshInFlight;
  }

  async forceRefresh(): Promise<void> {
    await this.refresh(await this.loadTokens(), true);
  }
}
