# cli-sources

The Google connectors for `ob`: Gmail and Calendar. It holds the OAuth client, the ingest that copies
mail and events into the tracker, and the `gmail`, `cal`, `agenda` and `google` commands.

See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#connectors) for how connectors fit in.

## Main modules

- `src/google.ts`: the OAuth token store and the HTTP client for Google's APIs. Client credentials and
  tokens are read through `ob secret`.
- `src/google-hosted.ts`: the OAuth callback when the sign-in completes on the API host. The `state`
  parameter guards against forged callbacks.
- `src/ingest/gmail.ts`, `src/ingest/calendar.ts`: copy messages and events into the `events` table
  and keep a cursor, so the next sync starts where the last one stopped.
- `src/gmail-message.ts`, `src/gmail-draft.ts`: read a message and write drafts.
- `src/sa-time.ts`: date handling in a fixed UTC+2 zone, with no daylight saving.
- `src/commands/gmail.ts`, `src/commands/calendar.ts` (`cal` and `agenda`), `src/commands/google.ts`:
  the commands.

The daemon jobs `gmail-sync` (every 5 minutes) and `cal-sync` (every 15 minutes) run the ingest.

## Dependencies

- Imports `apps/cli` (store, settings, secrets, events, errors) by relative path.
- Imported by `apps/cli/src/cli.ts` and by the `cli-core` tests.
- moon `dependsOn`: `cli`, `cli-db`.

## Tests

```sh
bunx moon run cli-sources:test
```

Tests run with `bun test` and preload `apps/cli/test/preload.ts` and `apps/cli/test/pg/warm.ts`.
`test/fake-draft-client.ts` is a helper, not a test. No test calls Google.

## Gotchas

- Creating a draft is not sending. Anything that sends mail needs the owner's confirmation of the exact
  text first.
- Times in `sa-time.ts` are fixed at UTC+2. Do not use it for a zone with daylight saving.
- Under API client mode some of these commands run on the server. See `apps/cli/src/api/routing.ts`
  for which ones.
