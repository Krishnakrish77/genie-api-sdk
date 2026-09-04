"""Authentication strategies for Genie API clients."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from asyncio import Lock as AsyncLock
from threading import Lock
from typing import Awaitable, Callable, Mapping, Protocol, Union

from authlib.common.security import generate_token
from authlib.integrations.httpx_client import OAuth2Client
from authlib.oauth2.rfc7636 import create_s256_code_challenge

HeaderMap = Mapping[str, str]
UserIdProvider = Union[str, Callable[[], str]]
DEFAULT_IDENTITY_BASE_URL = "https://id.workato.com"


class Auth(Protocol):
    """Supplies fresh request headers without exposing credentials to the client."""

    def headers(self) -> HeaderMap: ...


class AsyncAuth(Protocol):
    async def headers(self) -> HeaderMap: ...


@dataclass(frozen=True)
class ApiKeyAuth:
    api_key: str
    idp_user_id: UserIdProvider

    def headers(self) -> HeaderMap:
        user_id = self.idp_user_id() if callable(self.idp_user_id) else self.idp_user_id
        return {"Authorization": f"Bearer {self.api_key}", "X-IDP-User-Id": user_id}


@dataclass(frozen=True)
class OAuthAuth:
    """Uses an application-owned callback to obtain the current OAuth access token."""

    access_token_provider: Callable[[], str]

    def headers(self) -> HeaderMap:
        return {"Authorization": f"Bearer {self.access_token_provider()}"}


@dataclass(frozen=True)
class OAuthTokens:
    access_token: str
    refresh_token: str
    expires_at: datetime


@dataclass(frozen=True)
class OAuthAuthorizationRequest:
    authorization_url: str
    state: str
    code_verifier: str


class OAuthPkce:
    """OAuth 2.0 Authorization Code + PKCE helper for public Genie clients.

    Applications store the returned state, verifier, and tokens. This helper
    never accepts or sends a client secret.
    """

    def __init__(self, *, client_id: str, redirect_uri: str,
                 identity_base_url: str = DEFAULT_IDENTITY_BASE_URL,
                 http_transport: object | None = None) -> None:
        base = identity_base_url.rstrip("/")
        self._redirect_uri = redirect_uri
        self._authorization_endpoint = f"{base}/oauth/authorize"
        self._token_endpoint = f"{base}/oauth/token"
        kwargs = {"transport": http_transport} if http_transport is not None else {}
        self._client = OAuth2Client(
            client_id=client_id,
            client_secret=None,
            token_endpoint_auth_method="none",
            redirect_uri=redirect_uri,
            code_challenge_method="S256",
            **kwargs,
        )

    def create_authorization_request(self) -> OAuthAuthorizationRequest:
        state = generate_token(48)
        code_verifier = generate_token(96)
        authorization_url, _ = self._client.create_authorization_url(
            self._authorization_endpoint,
            state=state,
            code_challenge=create_s256_code_challenge(code_verifier),
            code_challenge_method="S256",
            scope="openid profile email",
        )
        return OAuthAuthorizationRequest(authorization_url, state, code_verifier)

    def exchange_callback(self, callback_url: str, request: OAuthAuthorizationRequest) -> OAuthTokens:
        from urllib.parse import parse_qs, urlparse

        if parse_qs(urlparse(callback_url).query).get("state", [None])[0] != request.state:
            raise ValueError("OAuth callback state does not match the login request")
        token = self._client.fetch_token(
            self._token_endpoint,
            authorization_response=callback_url,
            state=request.state,
            code_verifier=request.code_verifier,
        )
        return self._tokens_from(token)

    def refresh(self, tokens: OAuthTokens) -> OAuthTokens:
        token = self._client.refresh_token(self._token_endpoint, refresh_token=tokens.refresh_token)
        return self._tokens_from(token, tokens.refresh_token)

    def refreshable_auth(self, *, load_tokens: Callable[[], OAuthTokens],
                         persist_tokens: Callable[[OAuthTokens], None],
                         refresh_skew: timedelta = timedelta(seconds=60)) -> "RefreshableOAuthAuth":
        def refresh_and_persist(current: OAuthTokens) -> OAuthTokens:
            refreshed = self.refresh(current)
            persist_tokens(refreshed)
            return refreshed
        return RefreshableOAuthAuth(load_tokens=load_tokens, refresh_and_persist=refresh_and_persist,
                                    refresh_skew=refresh_skew)

    @staticmethod
    def _tokens_from(token: Mapping[str, object], previous_refresh_token: str | None = None) -> OAuthTokens:
        access_token = token.get("access_token")
        refresh_token = token.get("refresh_token", previous_refresh_token)
        if not isinstance(access_token, str):
            raise ValueError("OAuth token response did not include an access token")
        if not isinstance(refresh_token, str):
            raise ValueError("OAuth token response did not include a refresh token")
        expires_in = token.get("expires_in", 3600)
        return OAuthTokens(access_token, refresh_token, datetime.now(timezone.utc) + timedelta(seconds=float(expires_in)))


class RefreshableOAuthAuth:
    """Refreshes rotating tokens through an application-supplied atomic transaction."""

    def __init__(self, *, load_tokens: Callable[[], OAuthTokens], refresh_and_persist: Callable[[OAuthTokens], OAuthTokens],
                 refresh_skew: timedelta = timedelta(seconds=60)) -> None:
        self._load_tokens = load_tokens
        self._refresh_and_persist = refresh_and_persist
        self._refresh_skew = refresh_skew
        self._lock = Lock()

    def headers(self) -> HeaderMap:
        tokens = self._load_tokens()
        now = datetime.now(timezone.utc)
        expires_at = tokens.expires_at if tokens.expires_at.tzinfo else tokens.expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= now + self._refresh_skew:
            with self._lock:
                tokens = self._load_tokens()
                expires_at = tokens.expires_at if tokens.expires_at.tzinfo else tokens.expires_at.replace(tzinfo=timezone.utc)
                if expires_at <= datetime.now(timezone.utc) + self._refresh_skew:
                    tokens = self._refresh_and_persist(tokens)
        return {"Authorization": f"Bearer {tokens.access_token}"}

    def force_refresh(self) -> None:
        with self._lock:
            self._refresh_and_persist(self._load_tokens())


@dataclass(frozen=True)
class AsyncOAuthAuth:
    access_token_provider: Callable[[], Awaitable[str]]

    async def headers(self) -> HeaderMap:
        return {"Authorization": f"Bearer {await self.access_token_provider()}"}


class AsyncRefreshableOAuthAuth:
    """Async counterpart that never blocks an event loop during token refresh."""

    def __init__(self, *, load_tokens: Callable[[], Awaitable[OAuthTokens]],
                 refresh_and_persist: Callable[[OAuthTokens], Awaitable[OAuthTokens]],
                 refresh_skew: timedelta = timedelta(seconds=60)) -> None:
        self._load_tokens = load_tokens
        self._refresh_and_persist = refresh_and_persist
        self._refresh_skew = refresh_skew
        self._lock = AsyncLock()

    async def headers(self) -> HeaderMap:
        tokens = await self._load_tokens()
        if self._needs_refresh(tokens):
            async with self._lock:
                tokens = await self._load_tokens()
                if self._needs_refresh(tokens):
                    tokens = await self._refresh_and_persist(tokens)
        return {"Authorization": f"Bearer {tokens.access_token}"}

    async def force_refresh(self) -> None:
        async with self._lock:
            await self._refresh_and_persist(await self._load_tokens())

    def _needs_refresh(self, tokens: OAuthTokens) -> bool:
        expires_at = tokens.expires_at if tokens.expires_at.tzinfo else tokens.expires_at.replace(tzinfo=timezone.utc)
        return expires_at <= datetime.now(timezone.utc) + self._refresh_skew
