# AGENTS.md

## Project Layout

- `./exp` is the temporary directory for experiments, outputs, and scratch
  data (dev-host profiles, logs, screenshots). You may recreate it if it does
  not exist. **Do not put tracked code here.**
- `./tests` contains the test harness (`open_view.cjs`, `test_preview.cjs`,
  `cdp_eval.cjs`) and the `tests/workspace/` fixtures used by the dev host.
- `_refs/`: references, read-only
  - `_refs/vscode` : source code of vscode for refrence only
## Testing

```bash
npm run compile
code --extensionDevelopmentPath="$PWD" --user-data-dir="$PWD/exp/devhost" \
     --remote-debugging-port=9335 --new-window --disable-extensions \
     "$PWD/tests/workspace/test.md"
node tests/open_view.cjs 9335
node tests/test_preview.cjs 9335
```

See `docs/important/how-to-test.md` for the full pipeline and gotchas.
