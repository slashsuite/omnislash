# cli-whatsapp

The WhatsApp connector for `ob`. ob does not talk to WhatsApp itself. It runs a local bridge binary
(a Go program built on whatsmeow), reads the bridge's message database, and sends through the bridge's
local HTTP API.

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#connectors) for how connectors fit in.

## Main modules

- `src/commands/whatsapp.ts`: the `ob whatsapp` command and its subcommands.
- `src/whatsapp/bridge.ts`: starts, stops and checks the bridge. It spawns the binary named by the
  `whatsapp_bridge_bin` setting, detached, with a pidfile and a log per port. The daemon's
  `whatsapp-bridge` job keeps it running.
- `src/ingest/whatsapp.ts`: reads the bridge's `messages.db` (the `whatsapp_db_path` setting)
  read-only, copies new messages into the `events` table, and keeps a cursor. The daemon's
  `whatsapp-sync` job runs it every minute.
- `src/whatsapp/qr.ts`: pairing a phone by QR code. The dashboard's tokens page uses it.
- `src/whatsapp/send.ts`, `media.ts`, `avatar.ts`, `status.ts`: sending, media files, profile pictures
  and bridge status.
- `src/whatsapp/transcribe.ts`, `describe.ts`: turn voice notes and images into text.
- `src/whatsapp/suggest.ts`, `converse.ts`: draft replies with a headless model run.
- `src/whatsapp/search-guard.ts`: limits what the reply panel may put in a web search, so private
  details never leave the machine.
- `src/whatsapp/prefs.ts`: per-chat preferences.

## Dependencies

- Imports `apps/cli` by relative path.
- Imported by `apps/cli/src/cli.ts`, `apps/ob-dashboard`, `platform/dashboard-kit` (pairing) and the
  `cli-core` tests.
- moon `dependsOn`: `cli`, `cli-db`.

## Tests

```sh
bunx moon run cli-whatsapp:test
```

Tests run with `bun test` and preload `apps/cli/test/preload.ts` and `apps/cli/test/pg/warm.ts`. They
use fake bridges and never start the real binary.

## Gotchas

- The bridge binary is not built or shipped by this repo. Point `whatsapp_bridge_bin` at your own build.
- Never write to the bridge's `messages.db`. ob only opens it read-only.
- When the WhatsApp session drops, the bridge needs a new QR scan. `ob whatsapp bridge status` reports a
  bridge that is up but not linked.
- Sending a message is an external action and needs the owner's confirmation of the exact text.
