# Phase 1 map checklists

A mapper covers every item under **All repos**, then every item under its repo's role (`backend`, `frontend`, `infra` or `other`, from the config). An item that does not apply gets one line saying so. Every fact carries a citation `repo@sha10:path:line`; anything unconfirmed goes under Leads, marked `UNVERIFIED`.

The map describes; it does not judge. No severities, no recommendations. Its readers are the hunters, who need to know where the heavy work happens and what bounds it.

## All repos

- **Layout.** Top-level folders and what each holds; the main modules or packages; generated or vendored code.
- **Stack.** Language and runtime versions, frameworks, and the versions of the libraries that matter for load (database drivers, queue, HTTP client, cache client), from the lockfile.
- **Start-up.** How the process starts and what it sets up: adapters, global middleware, connections, background workers started in the same process.
- **Configuration that changes behaviour under load.** Timeouts, body and page limits, pool sizes, concurrency, rate limits, cache expiry, retry settings. Environment variable **names** only, never values.
- **External calls.** Every other service the repo calls (including the other repos of the audit), the client used, and its timeout and retry settings.
- **Gaps.** What you could not read and why: excluded folders, files missing from disk, generated code, private packages, the config's `known_gaps`.

## backend

- **Entry points.** HTTP routes (method, path, handler, guards), queue processors (queue name, concurrency), scheduled jobs (interval or cron, what they select), event listeners (event name, who emits it).
- **What grows per entry point.** For each entry point, the input that grows (items in a body, files in an upload, rows a job selects, distinct values that end up in a key) and the resource it consumes (memory, connections, worker or queue slots, event-loop time, an upstream rate budget).
- **Data model.** Every collection or table the code declares: fields that grow with the audit's size unit, embedded arrays, indexes declared in code, expiry (TTL), and where documents are created and updated.
- **Queries on hot paths.** For each frequent route or job: the query's filter, sort, projection and limit, and whether a declared index matches.
- **Queues.** Name, producers, processor, concurrency, attempts and backoff, job id scheme, retention of completed and failed jobs, and where the queue's store lives.
- **Schedulers.** What each one selects, how it marks progress, and whether two runs can overlap (locks, single-run options).
- **Heavy flows, end to end.** The flows whose cost grows with the size unit (bulk sends, imports, exports, recomputations, fan-out to other services): each step, with what it reads, loops over, sends and stores.
- **Shutdown.** Signal handling and what happens to in-flight requests and jobs.

## frontend

- **Data layer.** The HTTP client and its defaults (base URL, timeout, retries); the data-fetching library and its defaults (cache time, refetch triggers).
- **Screens that grow.** List, table and search screens: the page size they request, whether they page, filter and sort on the server or in the browser, and whether long lists are virtualised.
- **Heavy client-side work.** File parsing, exports, large computations: in the main thread or in a worker.
- **Backends called.** Which API each screen calls, including APIs outside the audit (say so).
- **Build and delivery.** Framework and bundler, code splitting, the largest dependencies, and how `index.html` and assets are cached by the web server.

## infra

- **What runs where.** Each deployable unit (web, workers, schedulers), its image, replica counts and autoscaling bounds per environment.
- **Resources.** CPU and memory requests and limits per container, per environment (defaults and overrides).
- **Probes and shutdown.** Liveness and readiness checks (path and what they touch), termination grace period, pre-stop hooks, the init or process manager in the image.
- **Edge.** Load balancer or ingress timeouts, body size limits, rate limits, caching.
- **Stores and their topology.** Database, cache and queue instances per environment as far as the repos show them: shared or separate, eviction policy, connection limits. Say plainly what the repos cannot show.
- **Network.** Outbound gateways, network policies, zones.
- **Observability.** Metrics endpoints, dashboards and alerts defined in code.

## other

- **Purpose.** What the repo is (a library, a script collection, a docs site, a shared package) and which other repos use it.
- **Anything that runs at size.** Scripts or jobs that touch production data, with what they read and write and how often they run.
- **What it constrains.** Shared limits, schemas or defaults that the other repos inherit from it.
