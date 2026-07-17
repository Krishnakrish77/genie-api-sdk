"""Synchronous client for the Genie Headless API."""

import json
from typing import BinaryIO, Iterator, Mapping, Optional, Tuple, Union

import httpx

from .models import Conversation, Event, Message, Page, Run

DEFAULT_BASE_URL = "https://genie-api.workato.com"


class GenieClient:
    def __init__(self, *, access_token: Optional[str] = None, api_key: Optional[str] = None,
                 idp_user_id: Optional[str] = None, base_url: str = DEFAULT_BASE_URL,
                 timeout: float = 30.0, http_client: Optional[httpx.Client] = None) -> None:
        if bool(access_token) == bool(api_key):
            raise ValueError("Provide exactly one of access_token or api_key")
        if api_key and not idp_user_id:
            raise ValueError("idp_user_id is required when using api_key")
        self._owns_client = http_client is None
        self._headers = {"Authorization": f"Bearer {access_token or api_key}", "Accept": "application/json"}
        if idp_user_id:
            self._headers["X-IDP-User-Id"] = idp_user_id
        self._client = http_client or httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "GenieClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @staticmethod
    def _path(genie_handle: str, suffix: str = "") -> str:
        return f"/api/v1/genies/{genie_handle}/chat{suffix}"

    def list_conversations(self, genie_handle: str, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Conversation]:
        data = self._client.get(self._path(genie_handle, "/conversations"), params={"limit": limit, "cursor": cursor}, headers=self._headers).raise_for_status().json()
        return Page([Conversation.from_dict(item) for item in data["list"]], data["total_count"], data.get("cursor"))

    def create_conversation(self, genie_handle: str) -> Conversation:
        data = self._client.post(self._path(genie_handle, "/conversations"), headers=self._headers).raise_for_status().json()
        return Conversation.from_dict(data)

    def get_conversation(self, genie_handle: str, conversation_id: str) -> Conversation:
        data = self._client.get(self._path(genie_handle, f"/conversations/{conversation_id}"), headers=self._headers).raise_for_status().json()
        return Conversation.from_dict(data)

    def list_messages(self, genie_handle: str, conversation_id: str, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Message]:
        data = self._client.get(self._path(genie_handle, f"/conversations/{conversation_id}/messages"), params={"limit": limit, "cursor": cursor}, headers=self._headers).raise_for_status().json()
        return Page([Message.from_dict(item) for item in data["messages"]], data["total_count"], data.get("cursor"))

    def send_message(self, genie_handle: str, conversation_id: str, message: str, *, file_id: Optional[str] = None) -> Run:
        data = self._client.post(self._path(genie_handle, f"/conversations/{conversation_id}/messages"), json={"message": message, "file_id": file_id, "stream": False}, headers=self._headers).raise_for_status().json()
        return Run(data["conversation_id"], data["genie_run_id"])

    def stream_message(self, genie_handle: str, conversation_id: str, message: str, *, file_id: Optional[str] = None) -> Iterator[Event]:
        return self._stream("POST", self._path(genie_handle, f"/conversations/{conversation_id}/messages"), json={"message": message, "file_id": file_id, "stream": True})

    def reconnect(self, genie_handle: str, conversation_id: str, genie_run_id: str, *, last_event_id: Optional[str] = None) -> Iterator[Event]:
        headers = {"Last-Event-ID": last_event_id} if last_event_id else None
        return self._stream("GET", self._path(genie_handle, f"/conversations/{conversation_id}/genie-runs/{genie_run_id}"), headers=headers)

    def list_events(self, genie_handle: str, *, since_created_at: Optional[str] = None, conversation_id: Optional[str] = None, limit: Optional[int] = None) -> Page[Event]:
        data = self._client.get(self._path(genie_handle, "/conversations/events"), params={"since_created_at": since_created_at, "conversation_id": conversation_id, "limit": limit}, headers=self._headers).raise_for_status().json()
        return Page([Event.from_dict(item) for item in data["events"]], len(data["events"]), next_since_created_at=data.get("next_since_created_at"))

    def resolve_skill_approval(self, genie_handle: str, conversation_id: str, call_id: str, resolution: str, *, rejection_reason: Optional[str] = None) -> None:
        if resolution not in {"approved", "rejected"}:
            raise ValueError("resolution must be 'approved' or 'rejected'")
        self._client.post(self._path(genie_handle, f"/conversations/{conversation_id}/skill_approval/{call_id}"), json={"resolution": resolution, "rejection_reason": rejection_reason}, headers=self._headers).raise_for_status()

    def get_runtime_connection_link(self, genie_handle: str, attempt_id: str) -> Mapping[str, object]:
        return self._client.post(self._path(genie_handle, f"/runtime_connection/{attempt_id}/link"), headers=self._headers).raise_for_status().json()

    def reject_runtime_connection(self, genie_handle: str, attempt_id: str, *, reason: Optional[str] = None) -> None:
        self._client.post(self._path(genie_handle, f"/runtime_connection/{attempt_id}/reject"), json={"reason": reason}, headers=self._headers).raise_for_status()

    def upload_file(self, genie_handle: str, conversation_id: str, file: Union[BinaryIO, Tuple[str, BinaryIO, str]]) -> str:
        response = self._client.post(self._path(genie_handle, f"/conversations/{conversation_id}/upload"), files={"file": file}, headers=self._headers)
        return response.raise_for_status().json()["file_id"]

    def _stream(self, method: str, url: str, **kwargs: object) -> Iterator[Event]:
        def events() -> Iterator[Event]:
            headers = {**self._headers, "Accept": "text/event-stream"}
            headers.update(kwargs.pop("headers", {}) or {})
            with self._client.stream(method, url, headers=headers, **kwargs) as response:
                response.raise_for_status()
                event_type: Optional[str] = None
                event_id: Optional[str] = None
                data_lines = []
                for line in response.iter_lines():
                    if not line:
                        if data_lines:
                            payload = json.loads("\n".join(data_lines))
                            yield Event.from_dict(payload, event_type, event_id)
                        event_type, event_id, data_lines = None, None, []
                    elif line.startswith("event:"):
                        event_type = line[6:].strip()
                    elif line.startswith("id:"):
                        event_id = line[3:].strip()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                if data_lines:
                    yield Event.from_dict(json.loads("\n".join(data_lines)), event_type, event_id)
        return events()
