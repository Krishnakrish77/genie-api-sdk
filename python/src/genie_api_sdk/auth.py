"""Authentication strategies for Genie API clients."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from asyncio import Lock as AsyncLock
from threading import Lock
from typing import Awaitable, Callable, Mapping, Protocol, Union

HeaderMap = Mapping[str, str]
UserIdProvider = Union[str, Callable[[], str]]


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
