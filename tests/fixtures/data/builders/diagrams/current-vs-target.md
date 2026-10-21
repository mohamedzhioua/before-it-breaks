### Today and the target

```mermaid
flowchart LR
  web["notes-web"] --> api["notes-api"]
  api --> db[("notes database")]
  api --> q["job queue"]
  q --> worker["digest worker"]
```
