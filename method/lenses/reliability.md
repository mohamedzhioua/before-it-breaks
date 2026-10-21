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

## The arithmetic to show

- **Run time against interval:** items per run × time per item, compared with the schedule interval. Example: 200 000 notes × 5 ms = 1 000 s per run, against a 60 s interval, so runs overlap from about 12 000 notes.
- **Drain time:** queue length ÷ (workers × concurrency × jobs per second per worker). Say which numbers come from config in the code and which are assumptions.
- **Duplicate exposure:** the window between the side effect and the "done" mark, times the retry or overlap rate. Often the honest answer is "any size: one retry is enough"; then `breaks_at` is "any size".
- **Retention growth:** failed items per day × bytes per item × days kept, compared with the store's memory or disk.

## Mitigations to search for before you claim

- a lock (database lock document, a PostgreSQL advisory lock, cache lock with expiry, the queue's own single-run option) or a unique job id per entity and run;
- a status claim at the start (`findOneAndUpdate` from `pending` to `running`) instead of at the end;
- an idempotency key or unique index that makes the second write fail harmlessly (`INSERT ... ON CONFLICT DO NOTHING` in SQL);
- in SQL: short transactions, `SELECT ... FOR UPDATE SKIP LOCKED` for job claims, `lock_timeout` and `statement_timeout`, and a retry on serialization failures and deadlocks;
- `attempts`, `backoff` and removal options on the queue or job, and where defaults are set;
- a timeout on the client instance (not only on one call), or a global default;
- graceful shutdown that waits for in-flight jobs;
- an outbox or a persisted queue behind the in-process event.

## Typical false positives

- The job runs on one worker only, by configuration that the hunter did not see (a single replica, a leader election, a queue concurrency of 1). Check how many copies really run.
- The side effect is naturally idempotent (setting a value, not adding to it).
- The retry option is set on the queue default, not on each `add()` call.
- The error is swallowed on purpose and the item is retried by a later sweep. Find that sweep before you claim loss.
- The race needs a timing that the trigger cannot produce (one user, one request at a time, by design).

## Evidence commands that usually prove it

- Show the job options: `git -C {repo:notes-api} grep -n -e 'removeOnFail' -e 'jobId' -e 'attempts' {pin:notes-api} -- src`
- Show the order of side effect and status write: `git -C {repo:notes-api} show {pin:notes-api}:src/jobs/notify.queue.ts | sed -n '1,40p'`
- Show the missing lock: `git -C {repo:notes-api} grep -n -i -e 'lock' {pin:notes-api} -- src/jobs` (empty output is the evidence; say so in `expect`).
- Show the schedule: `git -C {repo:notes-api} grep -n -e 'repeat' -e 'cron' {pin:notes-api} -- src`
- Lock waits in PostgreSQL are recorded, not run: `LIVE psql: SELECT pid, state, wait_event_type, xact_start FROM pg_stat_activity WHERE state <> 'idle'`.
- Live counts are recorded, not run: for a Bull or BullMQ queue, `LIVE redis-cli ZCARD bull:notifications:failed` (the failed set is a sorted set under the queue's key prefix), or the queue dashboard's failed count.
