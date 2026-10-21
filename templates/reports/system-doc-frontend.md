# <repo>: how it works today (front-end)

<!-- Outline for one front-end repo's system docs, written from the Phase 1
     map. Put it at system-docs/<repo>/architecture.md; split long sections
     into their own pages (for example heavy-screens.md, or
     data-fetching.md) and leave a link. Every fact cites
     <repo>@<short>:path:line at the pinned commit; unchecked facts are
     marked UNVERIFIED. Describe; do not judge.

     arc42 mapping: Overview and Screens = building blocks (level 2); Data
     fetching and Heavy screens = runtime view; Configuration = cross-cutting
     concepts. -->

**Pinned at:** `<repo>@<short>` · **Role:** front-end · **Mapped:** <YYYY-MM-DD>

## Overview

<What the app is for and who uses it. Framework, build tool and state or data library, with versions from the lockfile. How it is served.>

## Screens and routes

| Route | Screen | Data it loads | Notes |
|---|---|---|---|
| `/<path>` | <name> | <endpoints> | <old and new versions side by side, feature flags> |

## Data fetching

- **HTTP client:** <the shared instance or wrapper, base URL source, timeout, retries, interceptors>
- **Caching:** <library and settings: how long data stays fresh, refetch on focus, retries>
- **Paging:** <page sizes the screens ask for; screens that ask for "all">

## Heavy screens

<Screens that load or draw many items at once, parse files in the browser, or do long work on the main thread. For each: what grows with the size unit, and what keeps it bounded (virtualised lists, paging, workers), with citations.>

## Configuration

| Setting | Where it is read | What it controls |
|---|---|---|
| `<BUILD_VARIABLE_NAME>` | `<path:line>` | <...> |

Names only, never values.

## Not covered

<Code the map could not read, and anything decided at build or deploy time outside the repo.>
