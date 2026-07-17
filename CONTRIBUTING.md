# Contributing

## Development

Run the same checks used in CI:

```sh
cd python && python -m pip install -e '.[dev]' && python -m pytest -q tests
cd typescript && npm ci && npm run check && npm test
```

Keep Python and TypeScript APIs conceptually aligned. Add mocked regression tests for every behavioral change; never require live credentials or a live workspace.

## Releases

Update versions in `python/pyproject.toml` and `typescript/package.json`, add an entry to `CHANGELOG.md`, and use the manual Release workflow. Publishing is intentionally protected by the `pypi` and `npm` GitHub environments.
