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

## The arithmetic to show

Write the sums in the audit's size unit, step by step, and name each input (from the code, the config's known limits, or marked as an assumption):

- **Round trips:** items × calls per item × time per call. Example: 50 000 notes × 1 query × 2 ms = 100 s, against an edge idle timeout of 90 s.
- **Memory:** items × bytes per item, compared with the process or container limit. State where the bytes per item come from (field count, an average document size you measured, or an assumption to be measured).
- **Payload size:** items × bytes per item, compared with the limit that applies (request body limit, message size, the database's document size limit; MongoDB documents are limited to 16 MiB).
- **Quadratic growth:** for skip or `OFFSET` pagination over N rows with page size P, rows read ≈ N² / (2P). Example: N = 500 000, P = 500 gives about 250 million reads.
- **Time per event-loop block:** input size × cost per unit; say whether the unit cost is measured or assumed.

Give the size at which the sum crosses the limit as `breaks_at` (for example "about 45 000 notes"). If no sum applies, write `n/a:` and the reason.

## Mitigations to search for before you claim

Look for these, in the cited function, its callers and the configuration, and list what you checked in `mitigations_searched`:

- a `limit`, page size or cursor further up (the caller may pass one), or a hard cap in a DTO or validator;
- batching (`bulkWrite`, `insertMany`, `$in` in chunks, a batch size option);
- a concurrency limiter around fan-out (`p-limit`, a semaphore, a queue with a concurrency setting);
- a cache in front of the call, and its key and expiry;
- the work being moved to a background job elsewhere, with this path only enqueuing;
- a streaming reader instead of an in-memory read;
- eager loading or a join in the ORM call, or a single batched query (`WHERE id = ANY(...)`) in place of per-row lookups.

## Typical false positives

- The loop runs over a list that is small by construction (a fixed set of types, the user's own few devices). Check what bounds it.
- The query is bounded by a unique key or a small filter that the hunter missed.
- The path is an admin, migration or one-off script that never runs at the target size.
- The cost is real but far below the limit at the target size: that is a `low` at most, not a break.
- A per-item `await` inside a job that is meant to be slow and is not on any user's path, with no deadline to miss.

## Evidence commands that usually prove it

- Show the code: `git -C {repo:notes-api} show {pin:notes-api}:src/modules/notes/notes.repository.ts | sed -n '1,40p'`
- Show the missing bound: `git -C {repo:notes-api} grep -n -e 'limit' {pin:notes-api} -- src/modules/notes` (an empty result is evidence of absence; say so in `expect`).
- Show the loop with an await: `git -C {repo:notes-api} grep -n -W -e 'for (const' {pin:notes-api} -- src/modules/imports/import.service.ts`
- Find siblings: `git -C {repo:notes-api} grep -n -i -e 'skip(' -e 'offset' {pin:notes-api} -- src`
- A measurement that needs the live system starts with `LIVE` and is recorded, not run, for example `LIVE mongosh: db.notes.find({ workspaceId: <id> }).explain('executionStats')`, or `LIVE psql: EXPLAIN (ANALYZE, BUFFERS) SELECT ...` on a replica (ANALYZE runs the statement, so only for reads). To count N+1 queries, the ORM's query log from one request (pasted, or `LIVE`) is the evidence.
