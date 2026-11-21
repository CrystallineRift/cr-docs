# Server-Counted Steps

> Status: in review: cr-api #106 (`feat/oaklet-hatch`, stacked on the quest-toggles PR #105), cr-api-unity #193, cr-admin-web #46. Not merged. First user: the hidden hatch quest, see [Oaklet Hatch (internal, spoilers)](?page=guides/07-oaklet-hatch-internal).

The server counts a trainer's steps. A client never reports a step count: it reports where the player stands, and the server turns the movement between two accepted positions into steps. Steps feed the normal progress pipeline, so a quest objective (`WalkSteps`), a lifetime stat and achievements can use them. The step logic is generic; nothing in it knows about any quest or item.

## From positions to steps

The client keeps doing what it already did: `PUT /trainer/{trainerId}/location` with `{ areaKey, x, y, z, yaw }`, throttled client-side (about every 10 s or 0.5 m, forced on pause, quit and region change). On each accepted position the server:

1. Takes the horizontal (X/Z) distance from the previously stored position. Height is ignored.
2. Clamps it (below), giving the **counted distance**.
3. Computes `steps = floor((carry + countedDistance) / stepLength)` and keeps the remainder as the **carry** on the trainer row, so no distance is lost between reports.
4. When `steps > 0`, emits one `StepsWalked` outcome with `Quantity = steps` through the progress dispatcher (see [Progress Dispatcher](?page=backend/23-progress-dispatcher)).

**The clamp.** The counted distance is 0 when there is no previous position or timestamp, when the area key changed (compared case-insensitively; a teleport or scene change), when the elapsed **server** time since the previous accepted position is zero or negative, or when a coordinate is not finite. Otherwise it is `min(distance, maxSpeed * min(elapsedServerSeconds, maxElapsedSeconds))`. Elapsed time is the server's own clock, never the client's. A client therefore cannot inflate steps by claiming big jumps: it is limited to `maxSpeed` for at most `maxElapsedSeconds` per report.

**Defaults** (server config only, a client cannot change them; a missing or invalid value falls back to the default and never means "no limit"):

| Setting | Config key | Default |
|---|---|---|
| Step length | `Steps:StepLengthMeters` | 0.75 m |
| Maximum credited speed | `Steps:MaxSpeedMetersPerSecond` | 12 m/s |
| Maximum elapsed time credited per report | `Steps:MaxElapsedSeconds` | 60 s |

With the defaults one report can credit at most 720 m (960 steps), and 5000 steps need at least 3750 m of real movement.

**Exactly once.** The position write is a compare-and-set on a version counter, `trainers.location_version`, read together with the previous position. A write that loses the race still saves its position and timestamp but counts 0 steps and leaves the carry alone. The older plain save (`UpdateLastLocationAsync`) clears `last_pos_at` and bumps the version, so a teleport through it never counts.

## The route: `includeProgress`

`PUT /trainer/{trainerId}/location` keeps its auth and policy (the token's own trainer). Request: the old fields plus `includeProgress` (bool, default false).

- Without `includeProgress` the body stays the bare JSON `true`. This is deliberate: the released Unity client parses the body as a `bool`, so an object body would break it. Steps are counted either way.
- With `"includeProgress": true` the body is `{ "saved": true, "stepsWalked": 12, "progress": <ProgressReport> | null }`. `progress` is null when no steps were counted or no progress sink is wired. The new Unity client sends `includeProgress: true` and applies `progress` the way it applies every other progress report (so a completed objective, an achievement or a quest auto-claim flows out of the same call).
- 404 trainer not found. 400 for an unknown area key (the existing message) or a non-finite x, y, z or yaw (the body is a message string).

## Outcome, stat and objective

- `ProgressOutcomeKind.StepsWalked` = 18, `Quantity` = steps, no subject.
- Lifetime stat `steps_walked_total` (`StatKey.StepsWalkedTotal`): incremented by `Quantity`.
- Quest objective `WalkSteps` (60): see [Quest System](?page=backend/07-quest-system#walk-steps-take-item-and-hidden-quests-in-review).

## Where it lives

`CR.Trainers.Domain.Services/Steps/`: `StepCounter` (pure function), `StepCountingOptions`, `IClock` / `SystemClock`, `ITrainerLocationService` / `TrainerLocationService`. The store is the narrow interface `ITrainerLocationStore`, implemented by `BaseTrainerRepository` for both engines (narrow because the Unity client implements `ITrainerRepository`). Trainers reaches the pipeline only through `IProgressOutcomeSink` from Game.Model, so the Trainers domain does **not** depend on Quests.

**Columns** (migration **21401**, `CR.Trainers.Data.Migration`): `trainers.last_pos_at` (server time of the last accepted position, null = none), `trainers.step_carry` (double, default 0), `trainers.location_version` (bigint, default 0).

## Offline parity

Offline play runs the same code on local SQLite. The Unity installer registers `ITrainerLocationStore` (the SQLite trainer repository), `IClock` (`SystemClock`), `StepCountingOptions` (defaults), `ITrainerLocationService` and `IBackpackItems` (`StepCountingBindings.Install`). The client calls `ITrainerLocationService.UpdateAsync` for the position save, never the repository directly, and applies `Progress` from the result. Offline play is its own authority for steps. See [Hidden Quests and the Claim Reveal](?page=unity/52-hidden-quests-and-claim-reveal).

## Related Pages

- [Quest System](?page=backend/07-quest-system), [Progress Dispatcher](?page=backend/23-progress-dispatcher), [Stats](?page=backend/08-stats-system), [Trainer Progression](?page=backend/22-trainer-progression)
