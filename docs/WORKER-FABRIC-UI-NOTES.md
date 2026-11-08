# Worker Fabric UI: notes and contract asks

Read against the lead's implementation in `services/epaperclip/src/features/fabric.ts` (branch `feat/worker-fabric`, commit 6b04f69).
The UI already copes with every item below; these are the places where the code and docs/WORKER-FABRIC.md section 4 differ or where a
small addition would make the screens more truthful.

## Differences handled in the UI

1. Fabric not enabled: the route throws 503 `fabric_unavailable`; the contract says `{enabled:false}`. The UI treats both as "turned off".
2. `Worker.capabilities` and `Pending.capabilities` can be null before the first report (the type says non-null). The UI shows "Hardware not reported yet".
3. `POST /pending/:id/approve` answers `{ok, worker|null}`; the contract says `{worker}`. The UI does not read the body.
4. `connectedSince` is set from `conn.lastFrame` (last message time), not the time the socket connected. The Connection card labels it "Connected since" per the contract, so it will read wrongly; either track `connectedAt` or rename.

## Asks (none block the UI)

A. **Pairing outcome.** The UI infers "used" when a pairing vanishes from `pairings` before its expiry and no new worker appears, and it
   cannot tell used from cancelled or a replay attempt. Ask: keep spent pairings for the 15 minutes with `state: "pending"|"used"|"cancelled"|"expired"`
   and `workerId` once used, and add an audit event for a rejected replay, so the dialog can say exactly what happened.
B. **Error codes** for create-pairing failures (e.g. `no_transport`, `unreachable`) with a one-sentence `error`; the UI shows `error` verbatim.
C. **Environments.** Only create is available. Ask for `PATCH /api/fabric/environments/:id {workerId?, requirements?, assignAgents?}` and `DELETE`, so the Workers page can edit what it lists.
D. **Leases.** `Lease` carries `agentId`/`runId` only; an optional `agentName` would let the Leases tab show names instead of ids.
E. **Worker names and scope.** `PATCH companies` accepts ids; the UI sets all-or-one organization at pairing time only. An organization-name list in `GET /api/fabric` (`companyNames`) is not required.
