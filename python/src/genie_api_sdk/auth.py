"""Authentication strategies for Genie API clients."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Callable, Mapping, Protocol, Union

HeaderMap = Mapping[str, str]
UserIdProvider = Union[str, Callable[[], str]]


class Auth(Protocol):
    """Supplies fresh request headers without exposing credentials to the client."""

    def headers(self) -> HeaderMap: ...


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
    """Refreshes rotating OAuth tokens before expiry; applications own token storage."""

    def __init__(self, *, load_tokens: Callable[[], OAuthTokens], refresh_tokens: Callable[[str], OAuthTokens],
                 save_tokens: Callable[[OAuthTokens], None], refresh_skew: timedelta = timedelta(seconds=60)) -> None:
        self._load_tokens = load_tokens
        self._refresh_tokens = refresh_tokens
        self._save_tokens = save_tokens
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
                    tokens = self._refresh_tokens(tokens.refresh_token)
                    self._save_tokens(tokens)
        return {"Authorization": f"Bearer {tokens.access_token}"}
