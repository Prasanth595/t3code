# Communication lanes rollout

Communication lanes are opt-in when the server and selected provider advertise support. The
server stores verified routes and delivery receipts in the thread projection. Provider input still
uses its native transport role; the UI labels this as compatibility mode.

## Pause automatic internal queue delivery

Set `T3_COMMUNICATION_LANES_PAUSED=1` (or `true`) in the server process environment and restart
the server. The environment stops offering lanes on new threads. On existing lanes threads, new
internal input is stored as a queued run, and the next queued-run selection skips internal runs
but may select a verified human request. This also prevents internal completion steering into an
active turn. It does not interrupt a turn already in progress or delete or rewrite any queued run,
message, envelope, or receipt. Explicit user publication and human queue controls remain
available.

Remove the variable and restart to restore automatic internal queued-run delivery. The stored run
and message IDs remain the same; the next normal scheduling boundary can select them.

## Inspect a thread

An agent in the thread can call `t3_communication_diagnostics` with an optional `cursor` and
`limit` (maximum 100). The result includes queue counts, route and delivery receipt counts, and
paged pending run/message IDs. It returns no message text or attachments and cannot target another
thread. Include this metadata with a bug report to distinguish accepted input, provider offer,
provider acceptance, and an unknown consumption outcome.
