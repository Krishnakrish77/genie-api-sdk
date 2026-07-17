export type MaybePromise<T> = T | Promise<T>;

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
