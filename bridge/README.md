# claude-bridge

Tiny localhost HTTP server that wraps `claude -p` so the Chrome extension
can ask Claude to classify your open tabs into semantic groups.

## Run

```bash
node bridge/claude-bridge.js
```

Default: `http://127.0.0.1:8787`.

## Environment

| Var                     | Default   | Meaning                                          |
|-------------------------|-----------|--------------------------------------------------|
| `TAB_OUT_TREE_PORT`     | `8787`    | port to listen on                                |
| `TAB_OUT_TREE_MODEL`    | `haiku`   | model alias passed to `claude -p --model`        |
| `TAB_OUT_TREE_ORIGIN`   | `*`       | `Access-Control-Allow-Origin` value              |

## Endpoints

- `GET  /health` — `{ ok: true, model, port }`
- `POST /classify` — body `{ tabs: [{id, title, url}, ...] }`, returns
  `{ groups: [{name, tab_ids}], meta: {...} }`.

## Auto-start on login (optional)

Copy the plist into LaunchAgents:

```bash
cp bridge/com.albertying.tab-out-tree.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.albertying.tab-out-tree.plist
```

Stop with `launchctl unload ...`. Logs go to `~/Library/Logs/tab-out-tree.log`.
