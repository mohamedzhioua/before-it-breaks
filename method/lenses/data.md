# Lens: data

How the stored data and the queries over it behave as they grow: indexes, query shapes, document and row growth, write amplification, connection pools, schema changes and cache keyspaces. This lens asks "what does the database or cache have to do for this query at the target size, and does any single record or command outgrow its limit?"

The cost of loading results into the application is **performance**; losing or repeating writes under retries is **reliability**. Report a problem that is both under your group's lens and note the other.

## What to look for (any store)

- **Queries no index serves.** For each hot query (request paths, frequent jobs), write down its filter, sort and projection, then look for an index whose leading fields match the filter and then the sort. Without one the database reads far more than it returns.
- **Growing records.** Arrays or child lists embedded in one record that gain an element per event, per user or per item, history kept inside the record, results stored inside a job record. Large records slow every read of them, and some stores cap their size.
- **Huge id lists in one statement.** A filter built from every id of a tenant (`$in` in MongoDB, `IN (...)` in SQL).
- **Write amplification.** Many secondary indexes on a write-heavy collection or table; timestamps or counters updated on every read; a whole record rewritten to change one field.
- **Lost updates.** Read a record, change it in code, save it back, with no version check, row lock or atomic operator: concurrent writers overwrite each other.
- **Unbounded collections or tables.** Logs, events or notifications with no expiry and no clean-up job, on the same cluster as live data.
- **Pool and connection limits.** The driver's pool size against the concurrency that shares it (request handlers plus job workers per process), and pool size × processes × replicas against the server's connection limit.

## MongoDB

- **Index shape.** A filter on `workspaceId` with a sort on `createdAt` wants a compound index `{ workspaceId: 1, createdAt: -1 }`. An index on `createdAt` alone can only walk every note in date order and filter as it goes; with no usable index the query scans the collection (COLLSCAN), and a sort no index covers is done in memory.
- **Filters that rarely use an index well.** Unanchored or case-insensitive regular expressions (`/term/i`), `$where`, many `$expr` forms, and negations (`$ne`, `$nin`), which match most of the index and so select little.
- **The 16 MiB limit.** It applies to one BSON document, and so bites in three places: a single document that keeps growing (`$push` with no `$slice`); a single command or query document, such as one `$in` with hundreds of thousands of ids; and aggregation stages that build one document from many (`$group` with `$push` or `$addToSet` into one array, a `$lookup` that embeds every match). Bulk writes are different: the Node.js driver splits `bulkWrite` and `insertMany` into batches that fit the server's limits by itself, so a big bulk write costs time and memory but does not hit the 16 MiB limit as one command.
- **Pool.** The MongoDB Node.js driver defaults `maxPoolSize` to 100; check what the code sets and how many processes share the cluster.
- **Index builds.** Automatic index creation on start-up (for example Mongoose `autoIndex`) against a large collection in production.

## SQL (PostgreSQL and similar)

- **Unindexed foreign keys and filters.** PostgreSQL indexes primary keys and unique constraints automatically, but not the referencing column of a foreign key. Joins on it, and deletes of a parent row (which must check the child table), scan the child table. Check every column used in a hot `WHERE`, `JOIN` or `ORDER BY`.
- **Huge `IN` lists.** `WHERE id IN (...)` with thousands of bound values costs parse and planning time, and the wire protocol allows at most 65 535 bound parameters per statement. Passing one array parameter (`= ANY($1)`) or joining against a temporary table scales better.
- **Long transactions and lock waits.** A transaction held open across slow work (remote calls, user think time, a whole batch job) keeps its row locks, makes other writers wait, and in PostgreSQL holds back vacuum so dead rows pile up. Look for missing `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout`, and for `SELECT ... FOR UPDATE` on hot rows.
- **Connections.** PostgreSQL's `max_connections` (100 by default) against pool size × processes × replicas at the maximum replica count; each connection is a server process. Look for a connection pooler (PgBouncer or the provider's).
- **Migrations that lock.** `CREATE INDEX` without `CONCURRENTLY` blocks writes to the table for the whole build. `ALTER TABLE` takes an exclusive lock: adding a column with a volatile default (such as a random or clock value), or with any default before PostgreSQL 11, rewrites the whole table under that lock; changing a column type usually does too. Even a fast `ALTER TABLE` waits behind long queries, and every query after it waits behind it, so look for a `lock_timeout` in migrations.

## Redis and other caches

- **Key lookups by pattern.** `KEYS` blocks the server while it walks every key. `SCAN` with `MATCH` applies the pattern only after it has fetched each batch of keys, so a complete scan walks the whole keyspace of the database whatever the pattern: `notes:*` costs the same as `*:notes`, and the cost grows with the total number of keys, including keys of other features.
- **Values and expiry.** Large values per key, and keys with no expiry that grow with the tenant.
- **Eviction.** Queues sharing one instance with a cache that may evict: queue libraries such as BullMQ require `maxmemory-policy noeviction`, or jobs can silently disappear.

## The arithmetic to show

- **Scan cost:** records examined per query (the whole collection or table, or the tenant's share) × query rate. Example: a COLLSCAN over 20 000 000 notes on every list request.
- **Record growth:** elements per record × bytes per element, against the limit. Example: 120 bytes per entry reaches 16 MiB at about 140 000 entries. Say how you estimated the bytes per element (in BSON, field names count as well as values).
- **One query or command:** ids × bytes per id inside one `$in`, against 16 MiB. A 12-byte ObjectId takes about 20 bytes as a BSON array element once the type byte and the index key are counted; 500 000 ids are then about 10 MB. For SQL, count bound parameters against 65 535.
- **Write amplification:** writes per second × (1 + secondary indexes).
- **Connections:** pool size × processes per pod × maximum replicas, against the server limit.
- **Lock time:** rows in the table × time per row for a rewrite or index build, as the time writers are blocked (mark the time per row as an assumption unless measured).

## Mitigations to search for before you claim

- an index that serves the query, declared in the schema, in a migration, or in an index script (also look for compound indexes whose prefix matches);
- a `limit` or projection that keeps the read small even without an index;
- `$slice` on the `$push`, a cap in application code, or a separate collection or table for the growing part;
- chunking of `$in` / `IN` lists, or an array parameter;
- a TTL index, partitioning with dropped old partitions, or a clean-up job;
- optimistic concurrency (a version field checked on update), atomic operators (`$inc`, `UPDATE ... SET n = n + 1`) or row locks held briefly;
- pool options, timeouts and a connection pooler;
- `CREATE INDEX CONCURRENTLY` and `lock_timeout` in migrations.

## Typical false positives

- The collection or table is small by nature (configuration, per-tenant settings) and does not grow with the size unit.
- An index exists but is declared somewhere the hunter did not look (another module, a migration folder, the database itself). Code alone cannot prove an index is missing in production: say "not declared in code", and add a `LIVE` index-list command.
- The array grows per tenant setting, not per item, and stays small.
- The regular expression is anchored with `^` and case-sensitive, so it can use an index.
- A large bulk write through the MongoDB driver: the driver batches it, so the 16 MiB limit does not apply to the call as a whole.

## Evidence commands that usually prove it

- List the declared indexes: `git -C {repo:notes-api} grep -n -e 'index(' -e 'createIndex' -e 'CREATE INDEX' {pin:notes-api} -- src`
- Show the query: `git -C {repo:notes-api} show {pin:notes-api}:src/modules/notes/notes.repository.ts | sed -n '1,20p'`
- Show the growing array: `git -C {repo:notes-api} grep -n -F -e '$push' {pin:notes-api} -- src` (single quotes and `-F`, so `$` is plain text)
- Show pool options: `git -C {repo:notes-api} grep -n -e 'maxPoolSize' -e 'poolSize' -e 'max:' {pin:notes-api} -- src`
- Live checks are recorded, not run: `LIVE mongosh: db.notes.getIndexes()`, `LIVE mongosh: db.notes.find({ workspaceId: <id> }).sort({ createdAt: -1 }).explain('executionStats')`, `LIVE psql: EXPLAIN (ANALYZE, BUFFERS) SELECT ...` on a replica (ANALYZE runs the query, so never for a statement that writes), `LIVE psql: SHOW max_connections`, `LIVE redis-cli CONFIG GET maxmemory-policy`.
