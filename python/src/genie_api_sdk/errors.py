"""Typed errors returned by the Genie API."""

from typing import Any, Optional, Type

import httpx


class GenieError(Exception):
    pass


class ApiStatusError(GenieError):
    def __init__(self, status_code: int, body: Any, request_id: Optional[str] = None) -> None:
        super().__init__(f"Genie API request failed with status {status_code}")
        self.status_code = status_code
        self.body = body
        self.request_id = request_id


class BadRequestError(ApiStatusError): pass
class AuthenticationError(ApiStatusError): pass
class PermissionDeniedError(ApiStatusError): pass
class NotFoundError(ApiStatusError): pass
class ConflictError(ApiStatusError): pass
class UnprocessableEntityError(ApiStatusError): pass
class RateLimitError(ApiStatusError): pass
class InternalServerError(ApiStatusError): pass


def raise_for_status(response: httpx.Response) -> httpx.Response:
    if response.is_success:
        return response
    try:
        body = response.json()
    except ValueError:
        body = response.text
    error_type: Type[ApiStatusError] = {
        400: BadRequestError, 401: AuthenticationError, 403: PermissionDeniedError,
        404: NotFoundError, 409: ConflictError, 422: UnprocessableEntityError,
        429: RateLimitError,
    }.get(response.status_code, InternalServerError if response.status_code >= 500 else ApiStatusError)
    raise error_type(response.status_code, body, response.headers.get("x-request-id"))
