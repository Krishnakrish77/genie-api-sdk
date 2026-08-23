#!/usr/bin/env python3
"""A minimal terminal chat client built with genie-api-sdk.

Use this as a starting point for a server-side integration. It deliberately
does not auto-approve skills or open runtime-connection links.
"""

import argparse
import os
import sys
from typing import Iterable, Optional

from genie_api_sdk import ApiKeyAuth, Event, GenieClient


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set")
    return value


def run_turn(client: GenieClient, genie_handle: str, message: str, conversation_id: Optional[str] = None) -> str:
    """Create or resume a conversation, print its stream, and return its ID."""
    conversation_id = conversation_id or client.create_conversation(genie_handle).conversation_id
    print(f"Conversation: {conversation_id}")
    for event in client.stream_message(genie_handle, conversation_id, message):
        render_event(event)
    return conversation_id


def render_event(event: Event) -> None:
    if event.type == "agent.message":
        print(event.data.get("message", ""))
    elif event.type == "skill.confirmation_required":
        print("Skill confirmation required; do not auto-approve it.", file=sys.stderr)
    elif event.type == "runtime_connection.auth_required":
        print("Runtime connection authorization required; handle it in your application.", file=sys.stderr)
    elif event.type == "system.stream_interrupted":
        print("Stream was interrupted; the SDK is recovering.", file=sys.stderr)


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chat with a Genie through the Headless API")
    parser.add_argument("message", help="The user message to send")
    parser.add_argument("--conversation-id", help="Resume this conversation instead of creating one")
    parser.add_argument("--base-url", default=os.environ.get("WORKATO_BASE_URL", "https://genie-api.workato.com"))
    return parser.parse_args(argv)


def main(argv: Optional[Iterable[str]] = None) -> int:
    args = parse_args(argv)
    try:
        auth = ApiKeyAuth(required_environment("WORKATO_API_KEY"), required_environment("WORKATO_IDP_USER_ID"))
        genie_handle = required_environment("WORKATO_GENIE_HANDLE")
    except RuntimeError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2

    with GenieClient(auth=auth, base_url=args.base_url) as client:
        run_turn(client, genie_handle, args.message, args.conversation_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
