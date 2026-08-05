# E2E anchor test

## Mermaid diagram

```mermaid
flowchart LR
    A[Start here] --> B{Is it working?}
    B -->|Yes| C[Great result]
    B -->|No| D[Debug needed]
    C --> E[Feature one complete]
    C --> F[Feature two complete]
    D --> G[Fix the issue]
    D --> H[Fix the other]
    E --> I[Ship it]
    F --> I
    G --> I
    H --> I
    I --> J[Done with the work]
```

## Reading note

This is the reading position. The user reads this note right below the
diagram; when the diagram re-renders and grows, this line must not move.

Filler paragraph three. More scrolling room so the viewport can be
positioned with the diagram near the top edge and the note in view.

Filler paragraph four. Still more room, because a short document would
clamp the scroll position and defeat the test.
