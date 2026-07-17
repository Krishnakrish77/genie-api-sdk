import asyncio
from datetime import datetime, timedelta, timezone

import httpx

from genie_api_sdk import (AgentMessageEvent, ApiKeyAuth, AsyncGenieClient,
                           GenieClient, OAuthTokens, RefreshableOAuthAuth)


def test_shared_http_client_keeps_each_sdk_clients_credentials_isolated():
    seen = []

    def handler(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json={"conversation_id": "conversation"})

    transport = httpx.MockTransport(handler)
    shared = httpx.Client(transport=transport, base_url="https://example.test")
    first = GenieClient(auth=ApiKeyAuth("first-key", "first-user"), http_client=shared)
    second = GenieClient(auth=ApiKeyAuth("second-key", "second-user"), http_client=shared)

    first.create_conversation("genie")
    second.create_conversation("genie")

    assert seen == ["Bearer first-key", "Bearer second-key"]
    assert "authorization" not in shared.headers


def test_api_key_auth_resolves_the_current_user_for_each_request():
    current_user = "first-user"
    seen = []

    def handler(request):
        seen.append(request.headers["x-idp-user-id"])
        return httpx.Response(200, json={"conversation_id": "conversation"})

    client = GenieClient(
        auth=ApiKeyAuth("key", lambda: current_user),
        http_client=httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test"),
    )
    client.create_conversation("genie")
    current_user = "second-user"
    client.create_conversation("genie")

    assert seen == ["first-user", "second-user"]


def test_recovery_reconnects_from_last_event_and_returns_typed_events():
    requests = []

    def handler(request):
        requests.append(request)
        if "/genie-runs/" in request.url.path:
            assert request.headers["last-event-id"] == "started"
            body = b"event: agent.message\nid: reply\ndata: {\"genie_run_id\":\"run\",\"message\":\"Recovered\"}\n\nevent: processing.finished\ndata: {\"genie_run_id\":\"run\"}\n\n"
        else:
            body = b"event: processing.started\nid: started\ndata: {\"genie_run_id\":\"run\"}\n\nevent: system.stream_interrupted\ndata: {\"genie_run_id\":\"run\"}\n\n"
        return httpx.Response(200, content=body)

    client = GenieClient(auth=ApiKeyAuth("key", "user"), http_client=httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test"))
    events = list(client.stream_message("genie", "conversation", "hello"))

    assert isinstance(events[2], AgentMessageEvent)
    assert events[2].message == "Recovered"
    assert len(requests) == 2


def test_async_client_streams_typed_events():
    async def run():
        async def handler(request):
            assert request.headers["authorization"] == "Bearer key"
            return httpx.Response(200, content=b"event: agent.message\ndata: {\"message\":\"Hello\"}\n\n")

        client = AsyncGenieClient(auth=ApiKeyAuth("key", "user"), http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.test"))
        return [event async for event in client.stream_message("genie", "conversation", "hello")]

    events = asyncio.run(run())
    assert isinstance(events[0], AgentMessageEvent)
    assert events[0].message == "Hello"


def test_refreshable_oauth_auth_refreshes_once_and_persists_rotating_tokens():
    tokens = OAuthTokens("expired", "refresh-1", datetime.now(timezone.utc) - timedelta(seconds=1))
    refreshes = []

    def refresh(refresh_token):
        refreshes.append(refresh_token)
        return OAuthTokens("fresh", "refresh-2", datetime.now(timezone.utc) + timedelta(hours=1))

    def save(updated):
        nonlocal tokens
        tokens = updated

    auth = RefreshableOAuthAuth(load_tokens=lambda: tokens, refresh_tokens=refresh, save_tokens=save)
    assert auth.headers()["Authorization"] == "Bearer fresh"
    assert auth.headers()["Authorization"] == "Bearer fresh"
    assert refreshes == ["refresh-1"]
