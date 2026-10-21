# Lens: infra

How the system is deployed and run, and whether that holds at the target size: container limits, replica counts and autoscaling, health checks, shutdown, timeouts at the edge, egress and the topology of databases, caches and queues. This lens asks "what does the platform around the code allow, and where does the code assume more than it gets?"

Most infra facts live outside the application code: manifests, Helm charts, Terraform, CI files, Dockerfiles, and often in a hosting console no repo shows. Say clearly what the repos prove and what they cannot. The config's `known_limits` and each repo's `known_gaps` tell you what the team has already supplied.

## What to look for

- **Memory and CPU limits against the work.** A process limit that the heavy flows (found by the other lenses or in the maps) exceed at the target size. Burstable or shared CPU classes that slow down under sustained load.
- **Request and job timeouts that disagree.** An edge or load balancer idle timeout shorter than a request the code makes inline; a server request timeout longer than the edge one (the user sees an error, the work continues); a job lock shorter than the job.
- **Shutdown.** No graceful shutdown handler, a termination grace period shorter than the longest job or request, no pre-stop delay, or a process manager in the container that does not forward signals. Work in flight is cut on every deploy and scale-in.
- **Health checks.** Liveness checks that call the database (a slow database restarts every pod), readiness checks missing, checks pointing at a path that does not exist.
- **Autoscaling on the wrong signal.** Scaling on CPU when the bottleneck is a queue backlog or a connection pool; HTTP and workers in the same pods so that a job burst scales the web tier or starves it.
- **Shared single points.** One cache or database instance serving both a cache that may evict and a queue that must not; one network gateway for all outbound traffic; a single zone.
- **Connection budgets.** Pool size × processes × replicas against the database's connection limit, at the maximum replica count.
- **Observability gaps.** No metrics endpoint, no queue depth or error-rate signal: the failure will not be seen before users see it. Report this only where it hides a size-driven failure.

## The arithmetic to show

- **Memory:** the largest in-memory working set from a heavy flow (items × bytes per item) against the container limit.
- **Connections:** pool size × processes per pod × maximum replicas, against the database or cache limit.
- **Shutdown exposure:** jobs in flight in one pod (jobs started per minute × average job length in minutes), and the share of them that run longer than the grace period: roughly how many jobs are cut each time a pod stops, times pods per deploy.
- **Timeout gap:** inline request time at the target size (from the performance sum) against each timeout on the path, edge first.
- **Capacity:** requests or jobs per second at the target size ÷ throughput per replica, against the maximum replica count. Mark the throughput per replica as an assumption unless measured.

## Mitigations to search for before you claim

- resource requests and limits per container, and autoscaler bounds, in every environment's values file, not only the defaults;
- a `SIGTERM` handler that stops taking work and waits for in-flight jobs; a grace period and pre-stop hook in the manifests;
- separate deployments for web and workers;
- connection pool settings and timeouts in the application config;
- timeouts set at the edge in an ingress annotation, a load balancer resource or the Terraform for it;
- a statement in `known_gaps` or `known_limits` that already covers the point (then cite it rather than re-deriving it).

## Typical false positives

- A default value in a chart that every environment overrides. Read the environment files before claiming.
- A limit the team set in the hosting console and listed in `known_limits`: the code not showing it is not a finding.
- Missing observability with no size-driven failure behind it: note it, do not make it a candidate under this lens.
- A shutdown gap for work that is idempotent and re-queued automatically.

## Evidence commands that usually prove it

- Show limits and replicas: `git -C {repo:notes-ops} grep -n -e 'memory' -e 'cpu' -e 'replicas' {pin:notes-ops} -- deploy`
- Show the grace period and probes: `git -C {repo:notes-ops} grep -n -e 'terminationGracePeriodSeconds' -e 'livenessProbe' -e 'readinessProbe' {pin:notes-ops} -- deploy`
- Show the shutdown handling: `git -C {repo:notes-api} grep -n -e 'SIGTERM' -e 'enableShutdownHooks' {pin:notes-api} -- src` (empty output is the evidence; say so in `expect`).
- List the files that exist: `git -C {repo:notes-ops} ls-tree -r --name-only {pin:notes-ops}`
- Cluster state is recorded, not run: `LIVE kubectl get hpa`, `LIVE kubectl describe deployment notes-api`.
