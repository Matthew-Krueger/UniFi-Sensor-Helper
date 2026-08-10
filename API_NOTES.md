# UniFi Protect API Notes

Living document — updated as API discovery happens (SPEC.md section 8).
Nothing below is finalized; this pass only sets up the template. No live
discovery has been performed yet against a real console.

## Library evaluation

| Library | Ecosystem | Last release checked | Notes |
|---|---|---|---|
| _none evaluated yet_ | | | TODO: check npm for a maintained TS/Node UniFi Protect client before hand-rolling one. Python has `uiprotect`; look for a Node equivalent or a port. |

## Endpoints

Template per endpoint — duplicate this block as each one is confirmed:

### `POST /proxy/protect/integration/v1/alarm-manager/webhook/{id}`

- **Method**: POST
- **Auth**: TBD — confirm whether reachable unauthenticated on LAN or
  requires the API key.
- **Confidence**: inferred from SPEC.md's worked example config, not yet
  tested against a real console.
- **Firmware tested against**: none yet.
- **Request shape**: TBD.
- **Response shape**: TBD.

## Open questions (from SPEC.md section 11)

- Exact metric enum and units per sensor type (currently assumed: lux,
  temperature, humidity, leak — see `packages/shared/src/types.ts`).
- Push (websocket/realtime) vs. poll for sensor readings, and the
  USL-Environmental's actual reporting interval.
- Local API key generation path and the exact auth header (`X-API-KEY` is
  the documented pattern for UniFi's public APIs — unverified against this
  console's firmware).

## Discrepancies vs. documentation

_None recorded yet._
