# code-simplification

The right amount of abstraction is the minimum that the current behavior demands.

## Operating rules
- Three similar lines is better than a premature abstraction.
- Inline a one-call helper. Extract a helper at the third caller, not the second.
- Delete dead branches, dead variables, dead comments. The git history remembers.
- A function whose name has "and" or "or" is doing two things.

## Anti-patterns
- Generalizing for a hypothetical future caller.
- Wrapping standard-library calls in a project-specific helper that adds nothing.
- Replacing a clear sequential function with a chain of small helpers that each do nothing.
