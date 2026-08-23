import importlib.util
from pathlib import Path
from types import SimpleNamespace


def load_example():
    path = Path(__file__).parents[2] / "examples" / "python-cli" / "chat.py"
    spec = importlib.util.spec_from_file_location("genie_example_chat", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_example_creates_a_conversation_and_renders_agent_messages(capsys):
    example = load_example()

    class Client:
        def create_conversation(self, genie_handle):
            assert genie_handle == "genie"
            return SimpleNamespace(conversation_id="conversation")

        def stream_message(self, genie_handle, conversation_id, message):
            assert (genie_handle, conversation_id, message) == ("genie", "conversation", "hello")
            return [SimpleNamespace(type="agent.message", data={"message": "Hi"})]

    assert example.run_turn(Client(), "genie", "hello") == "conversation"
    assert capsys.readouterr().out.splitlines() == ["Conversation: conversation", "Hi"]


def test_example_requires_credentials(monkeypatch, capsys):
    example = load_example()
    monkeypatch.delenv("WORKATO_API_KEY", raising=False)
    assert example.main(["hello"]) == 2
    assert "WORKATO_API_KEY must be set" in capsys.readouterr().err
