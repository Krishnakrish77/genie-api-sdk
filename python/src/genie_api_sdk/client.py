"""Synchronous client for the Genie Headless API."""

import json
import time
from typing import BinaryIO, Iterator, Mapping, Optional, Set, Tuple, Union
from urllib.parse import quote

import httpx

from .auth import Auth
from .errors import raise_for_status
from .models import Conversation, Event, Message, Page, Run

DEFAULT_BASE_URL = "https://genie-api.workato.com"


class GenieClient:
    def __init__(self, *, auth: Auth, base_url: str = DEFAULT_BASE_URL,
                 timeout: float = 30.0, http_client: Optional[httpx.Client] = None) -> None:
        self._owns_client = http_client is None
        self._auth = auth
        self._client = http_client or httpx.Client(base_url=base_url.rstrip("/"), timeout=httpx.Timeout(timeout, read=None))

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "GenieClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @staticmethod
    def _path(genie_handle: str, suffix: str = "") -> str:
        return f"/api/v1/genies/{quote(genie_handle, safe='')}/chat{suffix}"

    @staticmethod
    def _id(value: str) -> str:
        return quote(value, safe="")

    @staticmethod
    def _json(**values: object) -> Mapping[str, object]:
        return {key: value for key, value in values.items() if value is not None}

    def _headers(self) -> Mapping[str, str]:
        return {"Accept": "application/json", **self._auth.headers()}

    def _safe_get(self, path: str, *, params: Optional[Mapping[str, object]] = None) -> httpx.Response:
        response = self._client.get(path, params=params, headers=self._headers())
        if response.status_code == 401 and hasattr(self._auth, "force_refresh"):
            self._auth.force_refresh()  # type: ignore[attr-defined]
            response = self._client.get(path, params=params, headers=self._headers())
        return raise_for_status(response)

    def list_conversations(self, genie_handle: str, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Conversation]:
        data = self._safe_get(self._path(genie_handle, "/conversations"), params={"limit": limit, "cursor": cursor}).json()
        return Page([Conversation.from_dict(item) for item in data["list"]], data["total_count"], data.get("cursor"))

    def create_conversation(self, genie_handle: str) -> Conversation:
        data = raise_for_status(self._client.post(self._path(genie_handle, "/conversations"), headers=self._headers())).json()
        return Conversation.from_dict(data)

    def get_conversation(self, genie_handle: str, conversation_id: str) -> Conversation:
        data = self._safe_get(self._path(genie_handle, f"/conversations/{self._id(conversation_id)}")).json()
        return Conversation.from_dict(data)

    def list_messages(self, genie_handle: str, conversation_id: str, *, limit: Optional[int] = None, cursor: Optional[str] = None) -> Page[Message]:
        data = self._safe_get(self._path(genie_handle, f"/conversations/{self._id(conversation_id)}/messages"), params={"limit": limit, "cursor": cursor}).json()
        return Page([Message.from_dict(item) for item in data["messages"]], data["total_count"], data.get("cursor"))

    def send_message(self, genie_handle: str, conversation_id: str, message: str, *, file_id: Optional[str] = None) -> Run:
        data = raise_for_status(self._client.post(self._path(genie_handle, f"/conversations/{self._id(conversation_id)}/messages"), json=self._json(message=message, file_id=file_id, stream=False), headers=self._headers())).json()
        return Run(data["conversation_id"], data["genie_run_id"])

    def _stream_message_once(self, genie_handle: str, conversation_id: str, message: str, *, file_id: Optional[str] = None) -> Iterator[Event]:
        return self._stream("POST", self._path(genie_handle, f"/conversations/{self._id(conversation_id)}/messages"), json=self._json(message=message, file_id=file_id, stream=True))

    def _reconnect(self, genie_handle: str, conversation_id: str, genie_run_id: str, *, last_event_id: Optional[str] = None) -> Iterator[Event]:
        headers = {"Last-Event-ID": last_event_id} if last_event_id else None
        return self._stream("GET", self._path(genie_handle, f"/conversations/{self._id(conversation_id)}/genie-runs/{self._id(genie_run_id)}"), headers=headers)

    def stream_message(self, genie_handle: str, conversation_id: str, message: str, *, file_id: Optional[str] = None, max_reconnects: int = 3) -> Iterator[Event]:
        """Stream a message with automatic reconnection and persisted-event replay."""
        if max_reconnects < 0:
            raise ValueError("max_reconnects must be non-negative")

        def events() -> Iterator[Event]:
            stream = self._stream_message_once(genie_handle, conversation_id, message, file_id=file_id)
            run_id: Optional[str] = None
            last_event_id: Optional[str] = None
            last_created_at: Optional[str] = None
            seen_ids: Set[str] = set()
            reconnects = 0
            retry_after_ms = 0
            while True:
                interrupted = False
                try:
                    for event in stream:
                        if event.event_id:
                            seen_ids.add(event.event_id)
                            last_event_id = event.event_id
                        if event.created_at:
                            last_created_at = event.created_at
                        run_id = event.genie_run_id or run_id
                        yield event
                        if event.type == "system.stream_interrupted":
                            retry_after_ms = max(0, int(event.data.get("retry_after_ms") or 0))
                            interrupted = True
                            break
                except httpx.TransportError:
                    if not run_id:
                        raise
                    interrupted = True
                if not interrupted:
                    return
                if run_id and reconnects < max_reconnects:
                    reconnects += 1
                    if retry_after_ms:
                        time.sleep(retry_after_ms / 1000)
                    stream = self._reconnect(genie_handle, conversation_id, run_id, last_event_id=last_event_id)
                    continue
                yield from self._replay_events(genie_handle, conversation_id, last_created_at, seen_ids)
                return

        return events()

    def _replay_events(self, genie_handle: str, conversation_id: str, since_created_at: Optional[str], seen_ids: Set[str]) -> Iterator[Event]:
        while True:
            page = self.list_events(genie_handle, conversation_id=conversation_id, since_created_at=since_created_at)
            for event in page.items:
                if not event.event_id or event.event_id not in seen_ids:
                    if event.event_id:
                        seen_ids.add(event.event_id)
                    yield event
            if not page.next_since_created_at:
                return
            since_created_at = page.next_since_created_at

    def list_events(self, genie_handle: str, *, since_created_at: Optional[str] = None, conversation_id: Optional[str] = None, limit: Optional[int] = None) -> Page[Event]:
        data = self._safe_get(self._path(genie_handle, "/conversations/events"), params={"since_created_at": since_created_at, "conversation_id": conversation_id, "limit": limit}).json()
        return Page([Event.from_dict(item) for item in data["events"]], len(data["events"]), next_since_created_at=data.get("next_since_created_at"))

    def resolve_skill_approval(self, genie_handle: str, conversation_id: str, call_id: str, resolution: str, *, rejection_reason: Optional[str] = None) -> None:
        if resolution not in {"approved", "rejected"}:
            raise ValueError("resolution must be 'approved' or 'rejected'")
        raise_for_status(self._client.post(self._path(genie_handle, f"/conversations/{self._id(conversation_id)}/skill_approval/{self._id(call_id)}"), json=self._json(resolution=resolution, rejection_reason=rejection_reason), headers=self._headers()))

    def get_runtime_connection_link(self, genie_handle: str, attempt_id: str) -> Mapping[str, object]:
        return raise_for_status(self._client.post(self._path(genie_handle, f"/runtime_connection/{self._id(attempt_id)}/link"), headers=self._headers())).json()

    def reject_runtime_connection(self, genie_handle: str, attempt_id: str, *, reason: Optional[str] = None) -> None:
        raise_for_status(self._client.post(self._path(genie_handle, f"/runtime_connection/{self._id(attempt_id)}/reject"), json=self._json(reason=reason), headers=self._headers()))

    def upload_file(self, genie_handle: str, conversation_id: str, file: Union[BinaryIO, Tuple[str, BinaryIO, str]]) -> str:
        response = self._client.post(self._path(genie_handle, f"/conversations/{self._id(conversation_id)}/upload"), files={"file": file}, headers=self._headers())
        return raise_for_status(response).json()["file_id"]

    def _stream(self, method: str, url: str, **kwargs: object) -> Iterator[Event]:
        def events() -> Iterator[Event]:
            headers = {**self._headers(), "Accept": "text/event-stream"}
            headers.update(kwargs.pop("headers", {}) or {})
            with self._client.stream(method, url, headers=headers, **kwargs) as response:
                raise_for_status(response)
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
