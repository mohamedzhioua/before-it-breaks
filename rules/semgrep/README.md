# Semgrep rules for scale problems

This folder holds Semgrep rules that flag code shapes which work on small data and get slow, expensive or wrong as data and traffic grow. They are written for Node.js and TypeScript back ends (NestJS, Mongoose, Bull/BullMQ, axios, Redis) and React front ends.

A hit is a lead for a reviewer, not a finding. Each rule sees one file at a time and cannot know how big an array or a collection really gets, so every hit still needs someone to trace where the data comes from and how large it can become. The audit workflow treats rule output that way: hits become candidates, and candidates are confirmed or rejected by reading the code.

| Folder | Content |
|---|---|
| `typescript/` | The default rule set: 15 rules, one `scale-<name>.yaml` file each |
| `typescript/tests/` | One test file per rule, `scale-<name>.ts` or `.tsx`, with `// ruleid:` and `// ok:` cases written on an invented notes platform |
| `run-tests.sh` | Runs every rule test and prints a summary |

No rule is currently in an `experimental/` folder: all 15 rules have passing tests in the default set.

Each rule carries the same metadata keys:

- `category`: `performance` or `reliability`.
- `kit-lens`: the audit lens the hit feeds (`performance`, `reliability`, `data`, `frontend`).
- `stack`: the libraries the rule assumes.
- `confidence`: `HIGH` (the shape is almost always a problem), `MEDIUM` (often a problem, sometimes bounded by design) or `LOW` (noisy; triage every hit).
- `references`: a link to this file.

## Running

You need Semgrep 1.181.0 (other recent versions will probably work but are not tested). Install it with `pipx install semgrep==1.181.0`, `uv tool install semgrep==1.181.0`, or use the `semgrep/semgrep:1.181.0` container image.

Run the rule tests:

```bash
bash rules/semgrep/run-tests.sh                # the typescript set
bash rules/semgrep/run-tests.sh -j 1           # strictly one rule after another
bash rules/semgrep/run-tests.sh experimental   # another rule-set folder, if present
```

The script runs each rule in its own `semgrep --test` process, with its own Semgrep settings file, up to four at a time (`-j N` or `SEMGREP_TEST_JOBS` changes that). It prints `PASS <id>` or `FAIL <id>` plus the Semgrep output for each failure, then one summary line, and exits 1 if any rule failed (2 for a usage problem such as a missing folder). The reason for the per-rule processes: on Windows, `semgrep --test <folder>` starts parallel workers that open the same user settings file and some of them stop with `PermissionError`. On Linux and macOS the single command works too:

```bash
semgrep --test --metrics=off --config rules/semgrep/typescript rules/semgrep/typescript/tests
```

Scan a repository once (JSON output for the audit, text for reading):

```bash
semgrep scan --metrics=off --config rules/semgrep/typescript --json -o scale-hits.json path/to/repo/src
semgrep scan --metrics=off --config rules/semgrep/typescript path/to/repo/src
```

With `--config <folder>`, Semgrep picks up just the `.yaml` rule files; the sample code beside them is never read as a rule. Semgrep scans only files tracked by git when the target is inside a git repository. The two front-end rules match any `.ts` or `.tsx` file: point them at the front-end folder named in your audit config, or run them separately with `--config rules/semgrep/typescript/scale-front-large-fixed-page-fetch.yaml`.

Check that the rule files are well formed:

```bash
semgrep scan --validate --metrics=off --config rules/semgrep/typescript
```

## CI

Start in report-only mode. Gate a pipeline on these rules only after the existing hits have been triaged, and then only on `WARNING`. Copy `rules/semgrep/typescript/` into the repository being checked (for example as `.semgrep/scale/`) or check this kit out next to it.

GitHub Actions (report-only: every severity is reported, nothing fails the job):

```yaml
name: scale-rules
on:
  pull_request:
  push:
    branches: [main]
jobs:
  semgrep-scale:
    runs-on: ubuntu-latest
    container:
      image: semgrep/semgrep:1.181.0
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # the baseline step needs the base commit
      - name: Rule tests
        run: semgrep --test --metrics=off --config .semgrep/scale .semgrep/scale/tests
      - name: Scan
        run: semgrep scan --metrics=off --config .semgrep/scale --json -o scale-hits.json src/
      - name: New hits in this pull request
        if: github.event_name == 'pull_request'
        run: |
          git config --global --add safe.directory "$GITHUB_WORKSPACE"
          semgrep scan --metrics=off --config .semgrep/scale             --baseline-commit "${{ github.event.pull_request.base.sha }}" src/
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: scale-hits
          path: scale-hits.json
```

GitLab CI:

```yaml
semgrep-scale:
  image: semgrep/semgrep:1.181.0
  stage: test
  variables:
    SCALE_RULES: .semgrep/scale
    GIT_DEPTH: 0   # the baseline command needs the base commit
    MR_BASE: $CI_MERGE_REQUEST_DIFF_BASE_SHA   # empty outside merge requests
  script:
    - semgrep --test --metrics=off --config "$SCALE_RULES" "$SCALE_RULES/tests"
    - semgrep scan --metrics=off --config "$SCALE_RULES" --json -o scale-hits.json src/
    - >
      if [ -n "$MR_BASE" ]; then
      semgrep scan --metrics=off --config "$SCALE_RULES"
      --baseline-commit "$MR_BASE" src/; fi
  allow_failure: true
  artifacts:
    paths: [scale-hits.json]
    when: always
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

The baseline step reports only hits that the base commit does not already have. Use `semgrep scan --baseline-commit`, not `semgrep ci`: in Semgrep 1.181 `semgrep ci` takes its rules from the Semgrep platform, and `--config` is not supported there. To make a step fail the job once the existing hits are triaged, add `--error` (and, if you want to gate on the higher-confidence rules only, `--severity WARNING`) to that step, and remove `allow_failure` in GitLab.

## The remote-call set

Three rules need to know what a "remote call" looks like: `scale-await-remote-call-in-loop`, `scale-swallowed-remote-error-then-bulk-write` and `scale-unbounded-promise-all-remote`. They share one list:

- `fetch(...)`, `got(...)`, `axios.<method>(...)`
- any `<x>.httpService.<method>(...)` call, bare or wrapped (`firstValueFrom(...)`, `lastValueFrom(...)`, `.pipe(...)`) (NestJS HttpService)
- `<x>.eventEmitter.emitAsync(...)` (waits for every listener, which usually do remote work)
- `<name>.<method>(...)` or `<x>.<name>.<method>(...)` where `<name>` ends in `client`, `gateway` or `sdk`, case-insensitive (for example `searchClient.index(...)`, `this.mailGateway.send(...)`)

In `scale-await-remote-call-in-loop` the awaited expression itself must be the call, except for HttpService, which is found anywhere inside the awaited expression (an awaited `Promise.all(...)` is skipped, because a chunked `Promise.all` inside a loop is the usual fix).

If your code reaches other systems through services named differently (`this.billingService`, `this.storage`), add a pattern for them to the list in all three files. A wrapper service that hides the remote call is not seen at all.

## Rules

### scale-unbounded-tenant-scoped-find

**Detects:** two shapes.

- Mongoose style: `find(...)` or `findMany(...)` on a receiver whose name contains `service`, `model` or `repo`, or is a capitalised name (`Note.find(...)`), with a filter that has a tenant key, and no limit option, no `.limit()` and no `.cursor()` in the call chain.
- Prisma style: `<x>.findMany({ where: { <tenant key>: ... } })` on any receiver, with no `take` in the arguments.

**Why it matters:** the call returns everything one tenant owns. It is fast for a test tenant and for most real ones; for the largest tenant it loads every document into one process, holds a database connection while it does, and can make that process run out of memory for every other tenant too.

**False positives:** collections that stay small per tenant by nature (settings, roles, templates); one-off migration scripts. An options object passed as a variable is flagged even if it contains a limit. A capitalised receiver that is not a model (a class with its own static `find`) is flagged too.

**False negatives:** filters or `where` objects built in a variable (`find(filter)`), tenant keys not in the list or nested deeper (`where: { note: { workspaceId } }`), lower-case receivers not named `*service*`/`*model*`/`*repo*`, Prisma `take` passed through a spread, other query builders (TypeORM `find({ where })` without `take` is not covered).

**Tuning:** the tenant key list is the `metavariable-regex` on `$KEY`. The default is `^(tenant|tenantId|account|accountId|org|orgId|organization|organizationId|workspace|workspaceId|project|projectId|owner|ownerId)$`. Replace it with the field names your schema uses to scope data to a customer. The receiver names for the Mongoose shape are the `metavariable-regex` on `$S`; the Prisma shape accepts any receiver, because a `where` object holding a tenant key is already a strong signal.

### scale-await-remote-call-in-loop

**Detects:** an `await` on a call from the remote-call set inside a `for`, `for...of` or `while` body (not inside an `array.map(async ...)` callback).

**Why it matters:** total time is roughly the number of items times the average round trip, because the calls run one after another and their times add up. At 100 ms per call, 1,000 items take 100 seconds, which is longer than most HTTP gateways wait, and the whole run is lost if the process restarts half way.

**False positives:** loops over lists that are small by design (a few configured endpoints), and loops where strict ordering is required and the item count is capped elsewhere.

**False negatives:** remote calls not in the remote-call set, calls hidden behind a local wrapper method. `.forEach(async ...)` is not this rule's shape (nothing is awaited in turn); `scale-unbounded-promise-all-remote` reports it.

**Tuning:** extend the remote-call set (see above).

### scale-sync-emit-in-loop

**Detects:** `<x>.eventEmitter.emit(...)` inside a `for`, `for...of` or `.forEach(...)`.

**Why it matters:** `emit` returns before async listeners finish. N items start N listener chains at once, with no limit, no error reporting back to the caller and no record of the work if the process stops.

**False positives:** small bounded lists; listeners that are purely synchronous and cheap.

**False negatives:** emitters not reached through a property named `eventEmitter`; `while` loops.

**Tuning:** change `$A.eventEmitter.emit(...)` to the name your code uses for its emitter.

### scale-offset-pagination-loop

**Detects:** a `while`, `do...while` or `for (;;)` loop that increases a variable whose name contains `skip` or `offset`.

**Why it matters:** each page re-reads every row before the offset. Walking N rows in pages of size P reads about N*N/(2P) rows: 1,000,000 rows in pages of 1,000 read about 500 million rows in total. Rows that move during the walk are also skipped or repeated.

**False positives:** walks over tables known to stay small.

**False negatives:** loops that count pages (`page++`) and compute the offset elsewhere; counters with other names; recursion instead of a loop.

**Tuning:** widen the `$SKIP` name regex if your code uses other names.

### scale-mongo-in-from-mapped-array

**Detects:** a MongoDB query (`find`, `findMany`, `findOne`, `countDocuments`, `updateMany`, `deleteMany`, `aggregate`) whose filter uses `$in` with `array.map(...)`, either inline or through a `const`/`let` assigned from `.map(...)` earlier in the function.

**Why it matters:** the id list grows with the source. A MongoDB command is limited to 16 MiB; an ObjectId in a BSON array takes about 20 bytes, so the query fails at a little over 800,000 ids, and both lists sit in memory before that.

**False positives:** many. Sources that are already bounded (one page of results, a request body with a validated maximum size) are flagged too. This rule is `LOW` confidence: trace where the source array comes from before acting.

**False negatives:** id lists built with loops, `Set`, or passed in from another function.

**Tuning:** narrow `$FIND` to the methods you care about.

### scale-mongoose-push-update-result-discarded

**Detects:** `findByIdAndUpdate` or `findOneAndUpdate` with `$push` as a statement whose result is not assigned or returned.

**Why it matters:** these methods return the whole document. Appending K items one at a time transfers about K*K/2 array entries in total, and the array pushes the parent toward MongoDB's 16 MiB document limit.

**False positives:** documents whose pushed array is capped (for example with `$slice`).

**False negatives:** the same call whose result is assigned but never read.

**Tuning:** none needed; the fix is mechanical (`updateOne`).

### scale-swallowed-remote-error-then-bulk-write

**Detects:** a `for` loop with a `try { await <remote call> } catch { ... }` that does not rethrow, followed later in the same function by `updateMany`, `deleteMany` or `bulkWrite`.

**Why it matters:** the local database records an item as done even when its remote call threw. The two systems disagree, and nothing records which items to retry. The larger the batch, the more certain some calls fail.

**False positives:** the bulk write uses only the ids that succeeded (a known false positive, kept in the test file as a `todook` case); the bulk write touches unrelated data.

**False negatives:** `Promise.all` with a per-item catch; the remote call made after the local write; loops split across functions.

**Tuning:** extend the remote-call set (see above).

### scale-unbounded-promise-all-remote

**Detects:** `Promise.all(array.map(...))`, `Promise.allSettled(array.map(...))` or `array.forEach(...)` whose callback makes a call from the remote-call set. `forEach` with a remote call (async or not) is reported here rather than in `scale-await-remote-call-in-loop`, because it starts every call at once: the problem is unbounded fan-out, and nothing waits for the results or sees their errors.

**Why it matters:** concurrency equals the array length. A list of 10,000 items opens 10,000 requests at once, which exhausts sockets and pools and triggers rate limits on the other side.

**False positives:** arrays that are bounded upstream (one page of results).

**False negatives:** remote calls outside the set; arrays mapped earlier into a promise list and awaited later; `for...of` loops that push promises into a list.

**Tuning:** extend the remote-call set (see above).

### scale-http-call-without-timeout

**Detects:** NestJS `httpService` calls with no options argument, or an inline options object without `timeout` or `signal`; `axios.create()` with no arguments, or with options that lack `timeout`; a `@Module` whose `imports` list has a bare `HttpModule`, or `HttpModule.register({...})` with an inline options object that lacks `timeout`.

**Why it matters:** neither axios nor HttpService has a default timeout. A hung upstream keeps the caller busy until the socket closes, and under load the stuck callers use up all capacity.

**False positives:** per-call hits on an HttpService whose module registers `HttpModule.register({ timeout })`: the call itself is then covered by the module default. Check the module that provides the service. If the rule reports that module (Case D in the YAML), the default is missing. If it does not, the module either sets a timeout inline or uses a form the rule does not judge (`registerAsync`, options in a variable), so read it. Also calls made only by one-off scripts.

**False negatives:** options passed as a variable, a function result or a leading spread are not judged; `HttpModule.registerAsync(...)` is not judged; HTTP clients other than HttpService and axios instances. Direct `axios.get(...)`-style calls and `fetch(...)` without `signal` are deliberately not reported: direct axios calls use `axios.defaults`, which is usually set in another file the rule cannot see, and Node's built-in `fetch` has undici's default header and body timeouts (about five minutes each), so flagging every such call would mostly be noise. Review them by hand when the audit covers outbound calls.

**Tuning:** change the `$C` regex if your HttpService property has another name.

### scale-queue-keeps-failed-jobs-forever

**Detects:** `removeOnFail: false` in any object literal (job options or queue defaults).

**Why it matters:** Bull and BullMQ then keep every failed job, with its payload, in Redis memory with no end date. A fixed `jobId` also stays taken by the failed job, so later adds with that id are ignored.

**False positives:** queues with tiny payloads and a separate clean-up job.

**False negatives:** options built in code (`removeOnFail: keepFailed`) where the variable is `false`.

**Tuning:** none; replace with `{ count: N }` or `{ age: seconds }`.

### scale-mongo-unanchored-case-insensitive-regex

**Detects:** `{ $regex: x, $options: 'i' }` or `{ $regex: new RegExp(x, 'i') }` where the pattern literal does not start with `^`, and `$regexMatch` over `$toString`.

**Why it matters:** an index helps only an anchored, case-sensitive regex. Everything else reads every document in range, so search gets slower as the collection grows, whatever the number of results.

**False positives:** the term is anchored outside the literal (for example `'^' + term` built earlier); collections that stay small.

**False negatives:** case-insensitive regexes built in a variable and passed in whole.

**Tuning:** none.

### scale-mongo-group-null-push

**Detects:** a `$group` stage with `_id: null` and at least one `$push` accumulator.

**Why it matters:** all matching values go into one output document, which has MongoDB's 16 MiB limit; the aggregation fails once the data grows past it, after building the whole array in memory.

**False positives:** a `$match` that is strictly bounded before the group.

**False negatives:** `$addToSet` and other accumulators that grow the same way.

**Tuning:** add `$addToSet` to the second inner pattern if you want it covered.

### scale-redis-scan-leading-wildcard

**Detects:** `scan(cursor, 'MATCH', '*...')` and `scanStream({ match: '*...' })` with a pattern literal that starts with `*`.

**Why it matters:** SCAN filters with MATCH after reading each batch, so a complete scan always walks the whole keyspace of the database. A fixed prefix does not help: `notes:*` costs the same as `*:notes`. The cost grows with the total key count of the instance, not with the matches. The rule flags the most visible form (a leading wildcard) of a lookup that is costly in every form. The fix is an index set or hash maintained on write (add the key on create, remove it on delete) and read directly, or a dedicated logical database or instance for these keys.

**False positives:** a logical database or instance that holds only these few keys.

**False negatives:** every SCAN with a MATCH that does not begin with `*` (prefix patterns, patterns held in a variable) has the same full-keyspace cost but is not flagged; `KEYS` calls are not covered either.

**Tuning:** to flag every pattern lookup, drop the `metavariable-regex` blocks on `$P`; expect more hits, each of them real cost.

### scale-front-large-fixed-page-fetch

**Detects:** an object literal in a `.ts` or `.tsx` file with `size`, `limit` or `pageSize` set to a number of 200 or more.

**Why it matters:** a fixed large window that the browser then filters or pages hides every row past the window, and every view downloads and renders the full window.

**False positives:** reference lists that are small by nature (countries, roles); unrelated objects that happen to use a `limit` key. This rule is `LOW` confidence.

**False negatives:** page sizes held in constants or computed values.

**Tuning:** the threshold is the `metavariable-comparison` (`$N >= 200`). Scan only the front-end folder, or the rule fires on back-end code too.

### scale-front-http-client-defaults

**Detects:** `axios.defaults.timeout` or `axios.create({ timeout })` above 120,000 ms, and `new QueryClient(...)` without `defaultOptions.queries.staleTime`.

**Why it matters:** load balancers often cut idle requests at about 60 seconds (check yours), so a longer browser timeout produces retries while the server is still busy with the first request. Without `staleTime`, every remount and focus refetches.

**False positives:** long timeouts used only for uploads or downloads that stream data; a `QueryClient` whose queries each set their own `staleTime` (the rule looks only at `defaultOptions`).

**False negatives:** timeouts held in variables or constants are not seen.

**Tuning:** the timeout threshold is the `metavariable-comparison` (`$N > 120000`); set it below your proxy's idle limit.
