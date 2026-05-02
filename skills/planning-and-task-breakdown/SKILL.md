# planning-and-task-breakdown

Break a spec into vertical slices that build on each other.

## Operating rules
- Each task is a vertical slice: it leaves the system in a working, testable state.
- Tasks build on each other. No task depends on a future task that hasn't started.
- Estimate each as XS / S / M. If anything is L, split it.
- Post the numbered task list as a comment on the source issue. Track progress by checking items off.

## Output shape
```
1. [ ] <task> (S) — <one-line why>
2. [ ] <task> (M) — <one-line why>
```

Don't include "set up the file structure" or "run tests" — those are part of every slice.
