import asyncio

import httpx

from genie_api_sdk import AgentMessageEvent, AsyncGenieClient, GenieClient


def test_shared_http_client_keeps_each_sdk_clients_credentials_isolated():
    seen = []

    def handler(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json={"conversation_id": "conversation"})

    transport = httpx.MockTransport(handler)
    shared = httpx.Client(transport=transport, base_url="https://example.test")
    first = GenieClient(api_key="first-key", idp_user_id="first-user", http_client=shared)
    second = GenieClient(api_key="second-key", idp_user_id="second-user", http_client=shared)

    first.create_conversation("genie")
    second.create_conversation("genie")

    assert seen == ["Bearer first-key", "Bearer second-key"]
    assert "authorization" not in shared.headers


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

    client = GenieClient(api_key="key", idp_user_id="user", http_client=httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test"))
    events = list(client.stream_message("genie", "conversation", "hello"))

    assert isinstance(events[2], AgentMessageEvent)
    assert events[2].message == "Recovered"
    assert len(requests) == 2


def test_async_client_streams_typed_events():
    async def run():
        async def handler(request):
            assert request.headers["authorization"] == "Bearer key"
            return httpx.Response(200, content=b"event: agent.message\ndata: {\"message\":\"Hello\"}\n\n")

        client = AsyncGenieClient(api_key="key", idp_user_id="user", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="https://example.test"))
        return [event async for event in client.stream_message("genie", "conversation", "hello")]

    events = asyncio.run(run())
    assert isinstance(events[0], AgentMessageEvent)
    assert events[0].message == "Hello"
