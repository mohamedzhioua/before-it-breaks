# Lens: frontend

What the browser or mobile client does as the data grows: how much it fetches, renders, parses and keeps, and how it talks to the backend under load. This lens asks "what happens on a user's device, and to the backend, when a screen meets a large tenant?"

A front-end problem can also be a backend problem (a page that asks for everything because the API cannot page). Report what the client does under this lens and say in `notes` which backend path it depends on; if that path is in another repo of the audit, cite it there too.

## What to look for

- **Fetch everything.** A request with a large or no page size (`limit=10000`, "all"), or a loop that fetches every page before showing anything.
- **Render everything.** Lists and tables that render every row with no virtualisation or paging. Thousands of DOM rows make scrolling and typing slow; each row's components multiply it.
- **Client-side filtering and sorting of server data.** The client downloads the whole set to filter it, so the cost grows with the tenant, not with what the user sees. Note also when this means the client receives data the user should not see (then one line in `notes`: security is usually out of scope).
- **Main-thread parsing.** Large files (CSV, spreadsheets, JSON) parsed in the browser's main thread: the page freezes for the duration. Look for a web worker or streaming parser.
- **Refetch amplification.** Data-fetching libraries with defaults that refetch on focus, on mount or every few seconds, multiplied by open tabs and users. In TanStack Query (react-query) the default `staleTime` is 0, so cached data counts as stale at once.
- **Timeouts and retries.** Very long or no client timeouts that keep requests open; automatic retries that multiply load during an outage.
- **Deploy and caching.** An `index.html` cached so long that, after a deploy, it points at chunk files that no longer exist (blank pages until a hard reload); no cache headers on hashed assets.
- **Bundle weight.** Very large dependencies loaded on first view. List them from the dependency file and the imports; do not run a build.

## The arithmetic to show

- **Payload:** rows fetched × bytes per row (from the response shape), against what a slow connection downloads in a reasonable time. Say what connection speed you assumed.
- **Render cost:** rows rendered × components per row; say that the time per component is an assumption unless measured.
- **Parse time:** file size or row count × parse cost per row (assumed unless measured), against the point where a page feels frozen.
- **Request rate:** users × open screens × refetches per minute, against what the backend path can serve (from the performance sums).

## Mitigations to search for before you claim

- server-side paging, filtering and sorting parameters actually sent by the client;
- a virtualised list component (react-window, @tanstack/react-virtual and similar) or pagination in the table component;
- a web worker or a streaming parser for files;
- `staleTime`, `refetchOnWindowFocus` and `retry` set on the query client or the query;
- cache headers in the web server config (`Cache-Control` for `index.html` and for hashed assets);
- code splitting (`lazy`, dynamic `import()` in the client code) for heavy screens.

## Typical false positives

- The large page size is only used by an admin or export screen that few people open; say so and size it honestly.
- The list is bounded by the backend (a hard cap on the API) even though the client asks for more.
- A legacy screen that calls an API outside the audit's scope: say which and leave it, unless the config includes it.
- Defaults that the app overrides on the shared query client; read the client set-up before claiming.

## Evidence commands that usually prove it

- Show the request size: `git -C {repo:notes-web} grep -n -e 'limit' -e 'pageSize' {pin:notes-web} -- app components`
- Show the rendering: `git -C {repo:notes-web} show {pin:notes-web}:components/note-list/NoteList.tsx | sed -n '1,60p'`
- Show the query client defaults: `git -C {repo:notes-web} grep -n -e 'staleTime' -e 'refetchOnWindowFocus' {pin:notes-web} -- app` (empty output is the evidence; say so in `expect`).
- List heavy dependencies: `git -C {repo:notes-web} show {pin:notes-web}:package.json | sed -n '1,80p'`
- Timings need a browser and are recorded, not run: `LIVE bench: load the workspace list with 50 000 notes and record the time to interactive`.
