# Lens: performance

Work whose cost grows faster than it should with the audit's size unit: more queries, more memory, more CPU or more time per request or job as the data grows. This lens asks "how much work does this do at the target size, and does that fit?"

Other lenses own neighbouring questions. A missing index is **data**; a lost or repeated job is **reliability**; pod limits and probes are **infra**; browser-side cost is **frontend**. When a performance problem is caused by one of those, report it under the lens your group was given and say in `notes` which other lens it touches.

## What to look for

- **Unbounded reads.** A query, scan or fetch whose result grows with the tenant: no `limit`, no page size, no cursor. In Node/TypeScript with MongoDB, `Model.find({ workspaceId })` with no `.limit()` and no cursor, or an aggregation whose `$match` selects a whole tenant and whose output is never bounded.
- **Whole collections in memory.** Results loaded into one array and then filtered, sorted or joined in application code. `.lean()` reduces the per-document cost but does not bound the count.
- **N+1 and per-item awaits.** An `await` inside a `for` / `for...of` / `while` loop over items that grow, each doing a database call, an HTTP call or an event emit. The cost is the item count times the round trip.
- **Quadratic work.** Nested loops over the same growing list, `array.includes` or `array.find` inside a loop over that array, repeated `concat` or spread into a growing array, sorting inside a loop.
- **Offset pagination loops.** `skip(page * size)` in a loop that walks the whole set: every page re-reads all earlier ones, so the total read is quadratic.
- **Large single payloads.** One request, message, job payload or document that holds every item: a bulk body, a queue job with all ids, an export built in memory. Compare its size with the known limits.
- **Synchronous CPU on the request path.** Parsing, hashing, compression, template rendering or JSON work on large inputs inside a request handler: in Node it blocks the event loop for every other request in that process.
- **Fan-out without a bound.** `Promise.all(items.map(...))` over a growing list of remote calls opens one call per item at once.
- **SQL and ORMs.** The same shapes, in SQL dress: a `SELECT` with no `LIMIT` over a table that grows with the tenant; `OFFSET` pagination, where the database still reads and throws away every row before the offset, so deep pages and page-by-page walks grow quadratically (keyset pagination, `WHERE id > $last ORDER BY id LIMIT n`, does not); and N+1 queries from an ORM's lazy loading, where touching a relation inside a loop (`note.author`, `await note.getTags()`) issues one query per row. Look for eager loading or joins (`include`, `relations`, `JOIN`) instead.
- **Inline work that should be queued.** A request that does the whole job (send to every user, rebuild every record) before it answers, racing the edge timeout.
- **Aggregate versus per-item limits.** Each item is checked against its own cap (a file size, a page size, a batch length, a concurrency per call), but nothing caps how many run at once or in total, so many items that each pass together use up a shared pool, the process memory, the database connections or an upstream rate budget. Shapes to look for: an import capped at 20 MB per file that takes any number of files in parallel; a page size of 100 with no cap on parallel page requests from a sync client; a `p-limit` created inside each request or job instead of once per process, so the limit multiplies with the number of requests.
- **Cache stampede.** A busy key expires, or a cold start finds the cache empty, and every request that misses in that moment recomputes the value and writes it back: the backing query runs once per waiting request instead of once, at the moment traffic is highest. Look for read-through code (get; on a miss, compute and set with a fixed expiry) with no lock, no shared in-flight promise and no early refresh, and for many keys written with the same expiry at the same moment (a warm-up after deploy), which then all lapse together.
- **Unbounded key or label cardinality.** Cache keys, Redis keys, metric labels or session entries built from values a user controls: a search string, a full URL with its query string, a user id as a metric label, a filter object serialised into a key. Every new value adds a key that lives until it expires, or for ever with no expiry, so memory follows the variety of input rather than the data. A module-level `new Map()` used as a cache with no size cap grows the same way inside the Node process; a metrics backend grows one series per label combination.
- **Superlinear regex or parsing.** A regular expression with nested or overlapping repeats (`(a+)+`, alternatives that can match the same text, a repeated group followed by `$`) run on request input, or a parser that recurses or re-scans on nested input (deep JSON, markdown, nested query-string objects). Node's regex engine backtracks, so one long or crafted input can cost seconds of CPU, and during that time the process answers no other request. `JSON.parse` on a large body is linear, but it still blocks.

## The arithmetic to show

Write the sums in the audit's size unit, step by step, and name each input (from the code, the config's known limits, or marked as an assumption):

- **Round trips:** items × calls per item × time per call. Example: 50 000 notes × 1 query × 2 ms = 100 s, against an edge idle timeout of 90 s.
- **Memory:** items × bytes per item, compared with the process or container limit. State where the bytes per item come from (field count, an average document size you measured, or an assumption to be measured).
- **Payload size:** items × bytes per item, compared with the limit that applies (request body limit, message size, the database's document size limit; MongoDB documents are limited to 16 MiB).
- **Quadratic growth:** for skip or `OFFSET` pagination over N rows with page size P, rows read ≈ N² / (2P). Example: N = 500 000, P = 500 gives about 250 million reads.
- **Time per event-loop block:** input size × cost per unit; say whether the unit cost is measured or assumed.
- **Aggregate use:** items in flight at once × cost per item, against the shared limit. Example: imports capped at 20 MB, with 30 workspaces importing at the same time on one process: 30 × 20 MB = 600 MB parsed in memory, against a 512 MiB container limit. For connections: parallel requests × queries in flight per request, against the pool.
- **Stampede load:** requests per second on the key × seconds to recompute = identical recomputes started in one miss window. Example: 500 requests per second on a workspace's note-count key and a 2 s count at 80 000 notes per workspace: about 1 000 copies of the same count start before the first one writes the value back, each scanning the workspace's notes.
- **Key growth:** distinct values per day × bytes per key × days each key lives (its expiry, or every day since start-up), against the store's memory. Example: a cache keyed by the raw search text, 200 000 distinct searches per day × 2 KB × a 7-day expiry = about 2.8 GB, against a 1 GB Redis instance. For metrics, series = the product of the distinct values of each label.
- **Backtracking cost:** steps as a function of input length (doubling with each extra character for an exponential pattern, n² for a quadratic one) × time per step, measured or assumed. Example: a quadratic pattern on a 20 000-character note title, at an assumed 10 ns per step: 20 000² = 400 million steps, about 4 s with the process frozen. This is rarely size-driven: when one request can send such an input, `breaks_at` is "any size"; say whether a body or field limit caps the length first.

Give the size at which the sum crosses the limit as `breaks_at` (for example "about 45 000 notes"). If no sum applies, write `n/a:` and the reason.

## Mitigations to search for before you claim

Look for these, in the cited function, its callers and the configuration, and list what you checked in `mitigations_searched`:

- a `limit`, page size or cursor further up (the caller may pass one), or a hard cap in a DTO or validator;
- batching (`bulkWrite`, `insertMany`, `$in` in chunks, a batch size option);
- a concurrency limiter around fan-out (`p-limit`, a semaphore, a queue with a concurrency setting);
- a cache in front of the call, and its key and expiry;
- the work being moved to a background job elsewhere, with this path only enqueuing;
- a streaming reader instead of an in-memory read;
- eager loading or a join in the ORM call, or a single batched query (`WHERE id = ANY(...)`) in place of per-row lookups;
- for aggregate limits: a limiter created once per process or shared across processes (a module-level `p-limit`, a Redis-backed semaphore or rate limiter, a queue with a global concurrency), a cap on files or items per request and on uploads in flight, and pool sizes chosen against the database's connection limit;
- for stampedes: a lock or shared in-flight promise around the recompute (a Redis `SET` with `NX` and an expiry, a per-key promise map in the process), serving the old value while one caller refreshes, random jitter on the expiry, and a warm-up spread over time;
- for key cardinality: an expiry on every key, keys built from bounded or normalised values (or a hash of them), an allowlist of metric label values, a size-capped LRU (for example `lru-cache` with `max`) in place of a bare `Map`, and a Redis `maxmemory` with an eviction policy (an infra fact; see the infra lens);
- for regex and parsing: patterns without nested repeats, a length cap before the pattern runs (a DTO `MaxLength`, the body limit), a linear-time engine such as `re2`, a parser with a depth limit, and heavy parsing moved to a worker thread or a queue.

## Typical false positives

- The loop runs over a list that is small by construction (a fixed set of types, the user's own few devices). Check what bounds it.
- The query is bounded by a unique key or a small filter that the hunter missed.
- The path is an admin, migration or one-off script that never runs at the target size.
- The cost is real but far below the limit at the target size: that is a `low` at most, not a break.
- A per-item `await` inside a job that is meant to be slow and is not on any user's path, with no deadline to miss.
- The items do not share the resource where it matters: each runs in its own job, and the queue's concurrency already caps the total.
- The stampede key is cheap to recompute (one indexed read), or each key gets little traffic: a few duplicate recomputes are noise, not a break.
- The key comes from a bounded set (a workspace id, an enum, a page number with a capped maximum), so the key count grows with the data, not with the input. That is ordinary growth, sized in the audit's unit, not unbounded cardinality.
- The pattern has overlapping repeats but only sees short, capped input (a slug already limited to 64 characters), or input that never comes from a request.

## Evidence commands that usually prove it

- Show the code: `git -C {repo:notes-api} show {pin:notes-api}:src/modules/notes/notes.repository.ts | sed -n '1,40p'`
- Show the missing bound: `git -C {repo:notes-api} grep -n -e 'limit' {pin:notes-api} -- src/modules/notes` (an empty result is evidence of absence; say so in `expect`).
- Show the loop with an await: `git -C {repo:notes-api} grep -n -W -e 'for (const' {pin:notes-api} -- src/modules/imports/import.service.ts`
- Find siblings: `git -C {repo:notes-api} grep -n -i -e 'skip(' -e 'offset' {pin:notes-api} -- src`
- Show where the limiter is created: `git -C {repo:notes-api} grep -n -W -e 'pLimit(' {pin:notes-api} -- src/modules/imports`
- Show the read-through cache and the missing lock: `git -C {repo:notes-api} grep -n -i -e 'expire' -e 'lock' {pin:notes-api} -- src/cache`
- Show how keys and labels are built: `git -C {repo:notes-api} grep -n -e 'cacheKey' -e 'labelNames' {pin:notes-api} -- src`
- Find nested repeats and regexes built at run time: `git -C {repo:notes-api} grep -n -E -e '[+*]\)[+*{]' -e 'new RegExp\(' {pin:notes-api} -- src`
- A key count from the live store is recorded, not run: `LIVE redis-cli INFO keyspace`.
- A measurement that needs the live system starts with `LIVE` and is recorded, not run, for example `LIVE mongosh: db.notes.find({ workspaceId: <id> }).explain('executionStats')`, or `LIVE psql: EXPLAIN (ANALYZE, BUFFERS) SELECT ...` on a replica (ANALYZE runs the statement, so only for reads). To count N+1 queries, the ORM's query log from one request (pasted, or `LIVE`) is the evidence.
