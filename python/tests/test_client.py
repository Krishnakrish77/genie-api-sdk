import httpx

from genie_api_sdk import GenieClient


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
