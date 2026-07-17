"""Public response models for the Genie Headless API."""

from dataclasses import dataclass
from typing import Any, Generic, List, Mapping, Optional, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class Conversation:
    conversation_id: str
    topic: Optional[str] = None
    last_updated_at: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    state: Optional[str] = None
    last_event: Optional[Mapping[str, Any]] = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Conversation":
        return cls(**{key: value.get(key) for key in cls.__dataclass_fields__})


@dataclass(frozen=True)
class Message:
    message_id: str
    source: str
    content: str
    genie_run_id: Optional[str] = None
    created_at: Optional[str] = None

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "Message":
        return cls(**{key: value.get(key) for key in cls.__dataclass_fields__})


@dataclass(frozen=True)
class Run:
    conversation_id: str
    genie_run_id: str


@dataclass(frozen=True)
class Event:
    """A Headless API SSE event. Event-specific fields are held in ``data``."""

    type: str
    event_id: Optional[str]
    conversation_id: Optional[str]
    genie_handle: Optional[str]
    genie_run_id: Optional[str]
    seq_num: Optional[int]
    created_at: Optional[str]
    data: Mapping[str, Any]

    @classmethod
    def from_dict(cls, value: Mapping[str, Any], event_type: Optional[str] = None, event_id: Optional[str] = None) -> "Event":
        base_keys = {"type", "event_id", "conversation_id", "genie_handle", "genie_run_id", "seq_num", "created_at"}
        event = cls(
            type=event_type or str(value.get("type", "message")),
            event_id=event_id or value.get("event_id"),
            conversation_id=value.get("conversation_id"),
            genie_handle=value.get("genie_handle"),
            genie_run_id=value.get("genie_run_id"),
            seq_num=value.get("seq_num"),
            created_at=value.get("created_at"),
            data={key: item for key, item in value.items() if key not in base_keys},
        )
        if event.type == "agent.message":
            return AgentMessageEvent(**event.__dict__, message=str(event.data.get("message", "")))
        if event.type == "skill.confirmation_required":
            return SkillConfirmationRequiredEvent(
                **event.__dict__, call_id=str(event.data.get("call_id", "")),
                skill_name=str(event.data.get("skill_name", "")), skill_id=str(event.data.get("skill_id", "")),
            )
        if event.type == "runtime_connection.auth_required":
            return RuntimeConnectionAuthRequiredEvent(
                **event.__dict__, runtime_connection_attempt_id=str(event.data.get("runtime_connection_attempt_id", "")),
            )
        if event.type == "system.stream_interrupted":
            return StreamInterruptedEvent(
                **event.__dict__, last_seq_num=event.data.get("last_seq_num"),
                reason=event.data.get("reason"), retry_after_ms=event.data.get("retry_after_ms"),
            )
        return event


@dataclass(frozen=True)
class AgentMessageEvent(Event):
    message: str


@dataclass(frozen=True)
class SkillConfirmationRequiredEvent(Event):
    call_id: str
    skill_name: str
    skill_id: str


@dataclass(frozen=True)
class RuntimeConnectionAuthRequiredEvent(Event):
    runtime_connection_attempt_id: str


@dataclass(frozen=True)
class StreamInterruptedEvent(Event):
    last_seq_num: Optional[int]
    reason: Optional[str]
    retry_after_ms: Optional[int]


@dataclass(frozen=True)
class Page(Generic[T]):
    items: List[T]
    total_count: int
    cursor: Optional[str] = None
    next_since_created_at: Optional[str] = None
