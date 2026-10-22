# Lens: reliability

Work that is lost, repeated, stuck or wrong when volume, concurrency, retries or restarts grow: background jobs, schedulers, retries, races and the handling of failures from other services. This lens asks "what happens to this work when two copies run at once, when it fails half-way, or when the process stops?"

Pure cost belongs to **performance**, indexes and document growth to **data**, pod settings to **infra**. A reliability problem often only shows at size (a job that takes longer than its interval once a tenant is large); show that link with a sum.

## What to look for

- **Non-idempotent jobs.** A job or handler that sends, charges, increments or appends before it records that it is done, so a retry or a second worker repeats the side effect.
- **Overlapping schedules.** A repeating job (cron, interval, repeatable queue job) that can still be running when the next run starts, with no lock or "already running" check. At size the run time grows past the interval.
- **Work re-selected while in progress.** A selector ("everything not yet sent") that picks up rows another worker is already handling, because the status is changed only at the end.
- **Check-then-act races.** Read a value, decide, then write, without an atomic update or a unique index: duplicate records, double counts, lost updates (read-modify-write of a whole document).
- **Lost in-process work.** `setImmediate`, un-awaited promises, in-memory queues or timers that hold work only in the process: a deploy, crash or scale-in drops it with no record.
- **Fire-and-forget events.** In Node, `EventEmitter.emit()` calls the listeners synchronously: an error thrown synchronously by a listener propagates out of `emit()` to the caller. But when a listener is `async` (or starts a promise), `emit()` returns before that work finishes and its rejection is not seen by the caller; unless the emitter was created with `captureRejections`, the rejection is unhandled. Then either a process-wide `unhandledRejection` handler logs it and the work is lost, or, with no handler, Node (since version 15) stops the process. Frameworks that wrap events (an `emitAsync`, an event bus) differ: check the one in use.
- **Retry settings that hurt.** No retries where a transient error is expected; unlimited or immediate retries that amplify an outage; a fixed job id that turns later adds into no-ops while a failed job with that id is still stored.
- **Swallowed errors.** A `catch` that logs and continues, after which the code acts as if the call worked (marks done, writes results, moves on).
- **Calls with no timeout.** An HTTP or database call that can wait forever holds a worker slot; under load all slots fill up. axios, for example, has no timeout by default (`timeout: 0`); check the default of whichever client is used.
- **SQL transactions and locks.** A transaction kept open across slow work (remote calls, a whole batch) holds its row locks, so other requests queue behind it and time out as volume grows; check-then-insert without a unique constraint or `INSERT ... ON CONFLICT` creates duplicates under concurrency; jobs claimed from a table without `SELECT ... FOR UPDATE SKIP LOCKED` (or an equivalent claim) are picked by two workers; and at stricter isolation levels, serialization failures and deadlocks need a retry that the code may not have. A migration that locks a hot table (see the data lens) stalls every request during a deploy.
- **Unbounded retention.** Failed jobs, logs or dead letters kept forever in the same store that serves live traffic.
- **Poison records.** One job, message or row that fails each time it is handled and sits where everything behind it must wait: a queue worked in strict order or with a concurrency of 1, a partition read in sequence, a sweep that restarts from the same row after each crash, a start-up step that must get through every pending record before the process takes traffic. With no attempt cap, no skip and no dead-letter or quarantine, one bad import stops every import queued after it. A hand-written Redis list consumer that pushes a failed item back to the head of the list is the plain case; for a job that crashes the whole worker (out of memory, a native parser abort), check how the queue library treats stalled jobs.
- **Detached work.** The caller gives up (its own timeout fires, the client disconnects, the edge closes the connection at its idle timeout) but the database query, HTTP call or queued step it started keeps going, because no `AbortSignal`, `maxTimeMS` or statement timeout was passed down. The abandoned work still holds a pool connection, a socket or a worker slot, and a client that retries adds a second copy beside the first. In Node, `Promise.race` against a timer ends the wait, not the work.
- **Unsafe recovery or replay.** The path that runs after a failure does more than the normal path: a restart that loads every pending record into memory at once, a retry that resends the whole batch rather than the part that failed, a fallback that drops the page size or rate limit of the main path, a replay that feeds back the very input that caused the crash. These paths run rarely, and only when the system is already in trouble, with a backlog that grew for as long as the outage lasted.

## The arithmetic to show

- **Run time against interval:** items per run × time per item, compared with the schedule interval. Example: 200 000 notes × 5 ms = 1 000 s per run, against a 60 s interval, so runs overlap from about 12 000 notes.
- **Drain time:** queue length ÷ (workers × concurrency × jobs per second per worker). Say which numbers come from config in the code and which are assumptions.
- **Duplicate exposure:** the window between the side effect and the "done" mark, times the retry or overlap rate. Often the honest answer is "any size: one retry is enough"; then `breaks_at` is "any size".
- **Retention growth:** failed items per day × bytes per item × days kept, compared with the store's memory or disk.
- **Head-of-line stall:** items arriving per minute × minutes the bad record blocks the line (attempts × (time per attempt + backoff)). Example: 300 imports per minute behind one note that fails 10 times with a 60 s backoff: about 10 minutes, so about 3 000 imports wait. With no attempt cap the stall never ends on its own, and `breaks_at` is "any size".
- **Detached load:** requests per second × seconds each query runs = queries in flight at once, compared with the pool size. Example: 40 note searches per second, each running 45 s at 60 000 notes per workspace, while the edge drops the caller at 30 s: 40 × 45 = 1 800 queries' worth of demand at once. A pool of 100 per process is full of work nobody waits for any more, and every other request queues behind it. The break is where query time passes the caller's timeout; give that in notes per workspace.
- **Recovery size:** arrival rate × outage length = backlog; backlog × bytes per item when the recovery path loads it at once, compared with the memory limit. Example: 2 000 notifications per minute × 90 minutes = 180 000 pending, × 4 KB = about 720 MB of raw data read at start-up, against a 512 MiB (about 537 MB) container limit. Parsed into JavaScript objects the same records take more room than their raw bytes, so the real break comes earlier; say whether the bytes per item are raw or measured in memory.

## Mitigations to search for before you claim

- a lock (database lock document, a PostgreSQL advisory lock, cache lock with expiry, the queue's own single-run option) or a unique job id per entity and run;
- a status claim at the start (`findOneAndUpdate` from `pending` to `running`) instead of at the end;
- an idempotency key or unique index that makes the second write fail harmlessly (`INSERT ... ON CONFLICT DO NOTHING` in SQL);
- in SQL: short transactions, `SELECT ... FOR UPDATE SKIP LOCKED` for job claims, `lock_timeout` and `statement_timeout`, and a retry on serialization failures and deadlocks;
- `attempts`, `backoff` and removal options on the queue or job, and where defaults are set;
- a timeout on the client instance (not only on one call), or a global default;
- graceful shutdown that waits for in-flight jobs;
- an outbox or a persisted queue behind the in-process event;
- against a poison record: an attempt cap that ends in a terminal state (the queue's failed set, a dead-letter collection or table), a per-item `try`/`catch` that records the error and moves on to the next item, and in SQL an attempt counter column next to the `SKIP LOCKED` claim;
- against detached work, only limits that stop the work on the server count: `statement_timeout` in PostgreSQL (and a `pg_cancel_backend` call when the caller aborts), `maxTimeMS` on MongoDB operations, an `AbortSignal` passed into the driver call where the driver cancels the operation with it, and for outgoing HTTP an `AbortSignal` handed to `fetch` or the client (`signal` in axios), plus a deadline a job checks between steps. node-postgres `query_timeout`, socket timeouts and MongoDB `socketTimeoutMS` only end the client's wait: the database keeps running the query, so they are not a mitigation here;
- for recovery and replay: start-up and retry code that reads through the same cursor, page size and rate limit as the normal path, a retry of only the failed part, and a quarantine for the record that was in hand when the process died.

## Typical false positives

- The job runs on one worker only, by configuration that the hunter did not see (a single replica, a leader election, a queue concurrency of 1). Check how many copies really run.
- The side effect is naturally idempotent (setting a value, not adding to it).
- The retry option is set on the queue default, not on each `add()` call.
- The error is swallowed on purpose and the item is retried by a later sweep. Find that sweep before you claim loss.
- The race needs a timing that the trigger cannot produce (one user, one request at a time, by design).
- The line is not single-file: other jobs keep flowing past a failing one (a BullMQ job waiting out its backoff sits in the delayed set while the worker takes the next job), so a bad record delays only itself. Show that the processing really is ordered before you claim a stall.
- The detached work is short and already capped on the server below the caller's timeout (`statement_timeout`, `maxTimeMS`), so it ends soon after the caller leaves. A client-side timeout does not count: it ends the wait, not the query.
- The recovery path is a script an operator starts by hand, not something that runs on start-up or by itself.

## Evidence commands that usually prove it

- Show the job options: `git -C {repo:notes-api} grep -n -e 'removeOnFail' -e 'jobId' -e 'attempts' {pin:notes-api} -- src`
- Show the order of side effect and status write: `git -C {repo:notes-api} show {pin:notes-api}:src/jobs/notify.queue.ts | sed -n '1,40p'`
- Show the missing lock: `git -C {repo:notes-api} grep -n -i -e 'lock' {pin:notes-api} -- src/jobs` (empty output is the evidence; say so in `expect`).
- Show the schedule: `git -C {repo:notes-api} grep -n -e 'repeat' -e 'cron' {pin:notes-api} -- src`
- Show the attempt cap and the failure path: `git -C {repo:notes-api} grep -n -e 'attempts' -e 'deadLetter' -e 'maxStalledCount' {pin:notes-api} -- src/jobs`
- Show that no signal or deadline reaches the call: `git -C {repo:notes-api} grep -n -e 'signal' -e 'maxTimeMS' -e 'statement_timeout' {pin:notes-api} -- src`. Empty output only covers the code under `src`: `statement_timeout` and `maxTimeMS` are often set on the database role, in the connection string, in environment variables or in config files. Say in `expect` that those places are not covered; gate 5 stays UNKNOWN until they are checked.
- Show what start-up loads: `git -C {repo:notes-api} grep -n -W -e 'onModuleInit' {pin:notes-api} -- src/jobs`
- Lock waits in PostgreSQL are recorded, not run: `LIVE psql: SELECT pid, state, wait_event_type, xact_start FROM pg_stat_activity WHERE state <> 'idle'`.
- Live counts are recorded, not run: for a Bull or BullMQ queue, `LIVE redis-cli ZCARD bull:notifications:failed` (the failed set is a sorted set under the queue's key prefix), or the queue dashboard's failed count.
