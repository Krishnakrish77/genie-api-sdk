#!/usr/bin/env python3
"""Opt-in smoke test against a non-production Genie workspace.

This script creates one conversation and sends one benign message. It is not
part of CI and refuses to run unless GENIE_E2E=1 is explicitly set.
"""

import os
import sys

from genie_api_sdk import ApiKeyAuth, GenieClient


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set")
    return value


def main() -> int:
    if os.environ.get("GENIE_E2E") != "1":
        print("Refusing to call a real workspace. Set GENIE_E2E=1 to run this smoke test.", file=sys.stderr)
        return 2

    try:
        auth = ApiKeyAuth(required_environment("WORKATO_API_KEY"), required_environment("WORKATO_IDP_USER_ID"))
        genie_handle = required_environment("WORKATO_GENIE_HANDLE")
    except RuntimeError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2

    message = os.environ.get("GENIE_E2E_MESSAGE", "Reply with exactly: SDK_E2E_OK")
    base_url = os.environ.get("WORKATO_BASE_URL", "https://genie-api.workato.com")
    with GenieClient(auth=auth, base_url=base_url) as client:
        conversation = client.create_conversation(genie_handle)
        saw_finished = False
        for event in client.stream_message(genie_handle, conversation.conversation_id, message):
            saw_finished = saw_finished or event.type == "processing.finished"

    if not saw_finished:
        raise RuntimeError("The stream ended without processing.finished")
    print(f"E2E smoke test passed (conversation {conversation.conversation_id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
