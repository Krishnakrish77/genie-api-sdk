# Python CLI example

This small terminal application demonstrates an API-key-backed integration with
the Python SDK. It creates a conversation unless `--conversation-id` is given,
then streams the Genie response.

Install the SDK from this repository for local development:

```sh
python -m pip install -e ../../python
```

Set configuration in your shell. Do not put real values in files or commit
them.

```sh
export WORKATO_API_KEY='...'
export WORKATO_IDP_USER_ID='...'
export WORKATO_GENIE_HANDLE='...'
```

Run a conversation:

```sh
python chat.py 'Reply with a short greeting'
```

Resume a conversation:

```sh
python chat.py --conversation-id 'conversation-id' 'What did we discuss?'
```

## Real API smoke test

Use a non-production workspace. The smoke test creates a conversation and
sends one message, so it is never run by CI. It refuses to run unless explicitly
enabled:

```sh
GENIE_E2E=1 python e2e_smoke.py
```

By default it asks the Genie to respond with `SDK_E2E_OK`; set
`GENIE_E2E_MESSAGE` to override that harmless prompt. Set `WORKATO_BASE_URL`
only when using another Workato data center or a test server.
