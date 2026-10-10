# endpoint-grid — design

A standalone app in the decode monorepo that replaces hand-testing the JIS
Finance API in Swagger UI. Every endpoint is a dot on a grid: green when its
live calls pass, red when they fail. Clicking a dot shows the exact checks
behind its color.

## Goal

- **Who:** developers running `MiCourt.Finance.Api` locally, who today click
  through Swagger UI one endpoint at a time.
- **Outcome:** one screen shows the health of every endpoint on the running
  local API, and each pass/fail can be explained down to the check.
- **Success:** after recording fixtures once, a developer starts the API,
  starts endpoint-grid, pastes a token, clicks Run, and sees every GET endpoint
  go green or red with a reason.

## Decisions

| Topic | Decision |
|---|---|
| Pass/fail source | Live HTTP calls to a running API |
| Request + criteria source | Recorded from the existing acceptance suite (`MiCourt.Finance.API.Acceptance.Test`) |
| Environment | Local only (`https://localhost:<port>`) |
| Location | New package `packages/endpoint-grid` in decode, its own entry point; not a `codeviz` subcommand |
| Recorder | One file in the JIS acceptance project, ignored via `.git/info/exclude`; no tracked JIS file changes |
| Auth | User pastes a bearer token; held in server memory only |
| Checks | Status code equals recorded + response shape equals recorded (keys and value types, not values) |
| Mutating calls | GET only. POST/PUT/PATCH/DELETE are shown, never called |
| Grid granularity | One dot per OpenAPI operation; green only if all its runnable fixtures pass |
| Layout | Controller tiles + bottom drill-down panel |

## Context

- Finance API: .NET 8, Swashbuckle 6.6.2, 12 controllers, 75 operations
  (38 GET, 37 mutating). OpenAPI doc at `/swagger/v1/swagger.json`.
- Acceptance suite: xUnit + `WebApplicationFactory<Program>`, all tests in one
  collection (`AcceptanceCollection`, runs serially), DB seeded by
  `MockData.ResetTestData`, external services mocked, auth mocked via
  `MockAuthentication`.

## Part 1 — Fixture recorder (JIS)

**File:** `jis/MiCourt.Finance.Api/MiCourt.Finance.API.Acceptance.Test/Shared/Fixtures/FixtureRecorder.cs`

**Ignored by:** a line in `jis/MiCourt.Finance.Api/.git/info/exclude`
(`MiCourt.Finance.API.Acceptance.Test/Shared/Fixtures/FixtureRecorder.cs`).
`.gitignore` is not edited because that is itself a tracked change. The csproj
is SDK-style, so the file compiles without a csproj edit.

**Mechanism (proven by spike on 2026-10-09):**

1. `[ModuleInitializer]` runs when the test assembly loads. If
   `RECORD_FIXTURES=<dir>` is set, it creates `<dir>` and sets
   `ASPNETCORE_HOSTINGSTARTUPASSEMBLIES` to the test assembly name. Otherwise
   it does nothing.
2. `[assembly: HostingStartup(typeof(FixtureRecorder))]` registers an
   `IStartupFilter` that puts a recording middleware first in the pipeline.
3. The middleware buffers the request body, swaps the response stream for a
   `MemoryStream`, calls `next`, then writes one fixture and copies the
   response back. A `HttpContext.Items` guard prevents double recording (the
   startup filter is applied twice under `WebApplicationFactory`).
4. An assembly-level `BeforeAfterTestAttribute` stores the current test name in
   a static field. Safe because the suite runs serially in one collection.

**Usage:**

```sh
RECORD_FIXTURES=~/.local/share/endpoint-grid/finance dotnet test MiCourt.Finance.API.Acceptance.Test
```

**Fixture format** (one file per call, `NNNN.json`):

```json
{
  "test": "PostPaymentPlanAsyncTests.ShouldAddPaymentPlan",
  "method": "POST",
  "route": "v{version:apiVersion}/paymentPlan",
  "path": "/api/finance/v1/paymentPlan",
  "query": "",
  "requestBody": "{...}",
  "status": 200,
  "responseContentType": "application/json; charset=utf-8",
  "responseBody": "\"c1ccde32-f9f5-4e10-9534-ae3ee7a5c955\""
}
```

**Hardening before use (beyond the spike):**

- Add `"version": 1` to each fixture and `"requestHeaders"` limited to
  `Content-Type` and `Accept` (never `Authorization`).
- Record `"authKind"`: `"valid"` when the request carried
  `MockAuthentication.GetValidToken()`, `"other"` when it carried any other
  token, `"none"` when it carried none. Fixtures with `"other"` or `"none"` are
  tagged test-only auth by endpoint-grid.
- Clear `<dir>` at the start of a recording run so stale fixtures don't
  accumulate.

The spike source is kept in the plan as the starting point.

## Part 2 — endpoint-grid (decode)

### Command

```sh
bunx endpoint-grid --api https://localhost:5001 --fixtures <dir> [--port 4400]
```

`--api` and `--fixtures` are required. The server binds `127.0.0.1` only and
prints the UI URL. TLS: local dev certificates are accepted for the `--api`
host only.

### Units

Each unit has one job and is tested on its own. Runtime code uses only
`node:*` APIs, per decode's rules.

1. **`catalog`** — `loadCatalog(apiUrl) → Endpoint[]`. Fetches
   `/swagger/v1/swagger.json`, returns `{ id, method, path, controller }` per
   operation. `id` is `"<METHOD> <path>"`. `controller` is the first OpenAPI
   tag. Order follows the document.
2. **`fixtures`** — `loadFixtures(dir, catalog) → { byEndpoint, orphans, unreadable }`.
   Replaces `{version:apiVersion}` with `v1`, strips the path base, matches
   the resulting template to a catalog path (exact template match, then
   segment-wise match treating `{x}` as a wildcard). Tags each fixture
   `runnable` (GET + `authKind: "valid"`), `mutating` (non-GET), or
   `test-only-auth` (GET + any other `authKind`).
3. **`checks`** — pure functions, no I/O.
   - `checkStatus(recorded, actual) → CheckLine`
   - `checkShape(recordedBody, actualBody) → CheckLine[]`: parse both as
     JSON when the recorded content type is JSON. Compare recursively: same
     keys, same JSON type per key (`string | number | boolean | null | object | array`).
     Arrays: compare element 0 of each when both are non-empty; empty vs
     non-empty is not a failure. Extra keys in the actual response fail.
     Non-JSON bodies: shape check is skipped and reported as skipped.
   - `CheckLine = { check, expected, actual, pass | "skipped" }`, e.g.
     `{ check: "body.cases[0].balance", expected: "number", actual: "missing", pass: false }`.
   - Shape is skipped when status fails.
4. **`overrides`** — reads and writes
   `~/.config/endpoint-grid/overrides.json`: per fixture key
   (`<test>#<n>`), a map of path-parameter and query values that replace the
   recorded ones.
5. **`runner`** — `run(fixtures, token, apiUrl, onResult)`. Applies
   overrides, sends each runnable fixture, at most 4 concurrent, 10 s timeout
   each, calls `onResult` per fixture with the check lines. Never sends a
   non-GET request; this is enforced here, not only in `fixtures`.
6. **`server`** — `node:http`:
   - `GET /` and static assets — the built UI
   - `GET /api/catalog` — endpoints, fixtures, tags, orphans, unreadable
   - `POST /api/token` — sets the in-memory token (never logged or persisted)
   - `POST /api/run` and `POST /api/run/:endpointId` — start a run; results
     stream back over SSE at `GET /api/events`
   - `PUT /api/overrides/:fixtureKey` — save an override
7. **`web`** — Vite UI (below). Its result → dot-state reducer is a pure
   module.

### UI

**Top bar:** masked token field, Run button, summary
(`31 ✓ · 4 ✗ · 37 not run · 3 no fixture`).

**Tiles:** one card per controller in document order: name,
`n/m GET pass`, dots in route order. Hover shows method + route.

| Dot | Meaning |
|---|---|
| Green | All runnable fixtures passed |
| Red | Any runnable fixture failed |
| Solid gray | Mutating, not run |
| Dashed outline | No fixture |
| Amber | Only test-only-auth fixtures (skipped) |
| Pulsing | Call in flight |

Before the first run, runnable dots are solid gray with a lighter tone than
mutating dots.

**Bottom panel** (opens on dot click, stays open while other dots are
clicked):

- Header: method + route, controller, fixture count, "Re-run this endpoint".
- One block per fixture: source test name, then check lines
  (`✓ status 200 = 200`, `✗ body.x: number ≠ missing`).
- Editable path and query values (saved as overrides).
- A 404 on a fixture with no override shows: "recorded ID may not exist in
  your DB".
- Collapsible raw view: request sent, actual response, recorded response.
- Mutating endpoints: recorded fixtures read-only, note "not run (GET-only)".

**Orphan fixtures** appear in their own tile after the controllers.

### Error handling

| Situation | Behaviour |
|---|---|
| API unreachable | Banner with the URL and a retry button; tiles hidden |
| `swagger.json` missing or invalid | Banner with the URL and parse error |
| No token | Run disabled, "Paste a bearer token" |
| Every response in a run is 401 where the recording was not 401 | Banner "Token rejected or expired"; dots stay gray |
| Timeout or network error | That fixture fails with `✗ timeout after 10s` / the error message |
| Malformed fixture file | Skipped; "N fixtures unreadable" with file names |
| Fixture route not in catalog | Listed in the Orphan fixtures tile |
| Fixture dir empty or missing | All dots dashed; panel shows the recording command |

### Testing

`bun test`, matching decode.

1. `checks` — table-driven: status match/mismatch; shape on nested objects,
   arrays (empty, non-empty), nulls, extra keys, missing keys, non-JSON.
2. `fixtures` — version substitution, route matching, tagging, malformed
   files. Test data: the 5 real fixtures recorded in the spike, checked in.
3. `catalog` — a trimmed copy of the real Finance `swagger.json`.
4. `runner` + `server` — integration test against a stub `node:http` API
   returning pass, fail, 401, and a response slower than the timeout; assert no
   non-GET request is ever sent.
5. `web` — reducer unit tests. One manual check against the real local API
   before calling it done.

The recorder has no unit tests; a real recording run produces the `fixtures`
test data, so a broken recorder is caught there.

## Known limitations

- Fixtures whose expected status depends on mocked services (e.g. `ShouldReturn401_WhenUnauthorizedToManagePlans`, which relies on `MockPolicyService`) may fail live because your real token has different permissions. The drill-down shows the source test name so this is visible; no automatic detection.
- Recorded GETs use `MockData` IDs; they need overrides when your local DB holds different data.

## Out of scope

- Shared dev/QA environments.
- Running mutating calls, DB reset/seeding.
- OpenAPI schema validation of responses.
- The Forms API (the design does not prevent adding it later).
- Changes to tracked JIS files.

## Estimate

Recorder hardening ~2 h · server, checks, runner ~2 days · UI ~2 days.
