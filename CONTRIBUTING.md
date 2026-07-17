# Contributing

## Development

Run the same checks used in CI:

```sh
cd python && python -m pip install -e '.[dev]' && python -m pytest -q tests
cd typescript && npm ci && npm run check && npm test
```

Keep Python and TypeScript APIs conceptually aligned. Add mocked regression tests for every behavioral change; never require live credentials or a live workspace.

## Releases

Update versions in `python/pyproject.toml`, `typescript/package.json`, and `typescript/package-lock.json`, then add an entry to `CHANGELOG.md`. Python beta versions use `0.1.0b1` and the equivalent npm version uses `0.1.0-beta.1`. Use the manual Release workflow from `main`; it validates, publishes through the protected `pypi` and `npm` environments using trusted publishing, and creates a `v<npm-version>` release tag only after both publishes succeed. Protect `v*` tags with a repository ruleset before treating release tags as immutable.
