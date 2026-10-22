# Audit report (excerpt): connect-mongo session growth audit

> Excerpt: the High finding, cut from the 02-audit-report.md page the kit generated in the pilot. See [README.md](README.md).

The size that matters is **active sessions in one store**, with a target of 1M. Audit date 2026-10-22; pinned commits `connect-mongo@182cfb09ad`. Citations read `repo@commit:path:line`.

## High (1)

### SVC-REL-01

**If MongoDB is unreachable for too long while an app process starts, or the expiry index cannot be created, that process either crashes or stays up and fails every logged-in request until someone restarts it. This can happen at any number of sessions.**

| | |
|---|---|
| Verdict | PROVEN-STATIC |
| Severity | High |
| Area | infrastructure · repo `connect-mongo` |
| Tier | n/s |
| Breaks at | not size-driven |
| Effort | M |
| Also covers | - |
| Receipt | [`354865edab2e`](work/phase3/receipts/SVC-REL-01.md) |

**What happens.** The store builds its collection handle only once, in the constructor: collectionP = clientP.then(... await createIndex ...). Under the default autoRemove 'native', that promise rejects if MongoClient.connect fails or if createIndex fails. Causes include a primary election or network error at deploy time, MongoDB not yet reachable when the container starts, or an existing 'expires' index with other options, for example one the host created itself as the README advises. Once rejected, the promise stays rejected. Every later get/set/touch/destroy awaits the same promise and fails at once. For each such process, every request that carries a session cookie gets a store error until someone restarts it, even after MongoDB is healthy again. If no store call is waiting at the moment of rejection, nothing has attached a handler to collectionP. Node (15 and later, with no host handler) then treats it as an unhandled rejection and stops the process. So the outcome depends on whether traffic arrived before the failure: either a crash, or a process that stays up but cannot serve sessions. This does not depend on the session count. As more app processes are added to serve more sessions, more of them start during any one deploy or election, so more processes are exposed.

**Mechanism.** Line 227: `_clientP = MongoClient.connect(options.mongoUrl, options.mongoOptions)`. Lines 238-244: `this.collectionP = _clientP.then(async (con) => { const collection = con.db(options.dbName).collection(...); await this.setAutoRemove(collection); return collection })`. setAutoRemove in 'native' mode returns `collection.createIndex({ expires: 1 }, { background: true, expireAfterSeconds: 0 })` (lines 262-270). collectionP is assigned only at line 238 and never reset. No .catch is attached to it at construction. Every method starts with `await this.collectionP` (384, 444, 499, 530) or `this.collectionP.then(...)` (558, 577, 588), so a single rejection turns into a lasting failure of every method. Nothing retries, rebuilds the promise lazily, or emits 'disconnect'/'connect' events.

**Threshold.** Not size-driven (reach skeptic's corrected threshold, used here). One rejected start-up connect or createIndex is enough, and that process stays broken until it restarts. Triggers: MongoDB unreachable past server selection at start-up (driver default 30 s, unverified), a network error during createIndex, or an existing expires index with conflicting options. A short primary election alone probably does not trigger it. Exposure grows with the number of processes that start during an unhealthy window, not with sessions. *(corrected by the skeptics; the original sums are in the verification log)*

**Evidence.** `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:226` · `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:238` · `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:262` · `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:384` · `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:444` · `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:499` · `connect-mongo@182cfb09ad:src/lib/MongoStore.ts:558`

**Fix direction.** Make start-up initialisation recoverable: on failure, drop the cached connection/collection promise and rebuild it lazily on the next call with bounded retries and backoff. Treat an existing compatible expires index as success, attach a handler at construction so the process does not crash, and emit connect/disconnect events so the session middleware can degrade gracefully.
