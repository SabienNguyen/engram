---
name: no-slop-prose
description: House writing style for this repo — use whenever producing or editing prose here: the README, docs/superpowers specs and plans, the tutor prompt, MCP tool descriptions and contract text, code comments, commit messages, PR titles and bodies, and replies about this codebase. Also use when reviewing prose in a diff. The goal is prose that reads as though a careful engineer wrote it for one specific reader, not as though a model filled a template.
---

# No-Slop Prose

Slop is not bad grammar. Slop is text that is *structurally indifferent to its reader*: padded,
hedged, symmetrical, and confident about nothing. It passes a spellcheck and teaches nothing.

Every sentence must carry information the previous sentence did not. If you delete a sentence and
the reader loses nothing, it was slop — delete it.

## The tells

**Throat-clearing.** Never open by announcing what you are about to say, restating the request, or
summarizing the document inside the document.

- Slop: "This document provides a comprehensive overview of the various considerations involved in..."
- House: "The MCP server is memory + graph queries only — it never teaches."

**Filler vocabulary.** These words almost never survive a rewrite. Delete or replace with the
specific thing:

`comprehensive` · `robust` · `seamless` · `leverage` · `utilize` · `delve` · `crucial` ·
`vital` · `elevate` · `unlock` · `harness the power of` · `it's important to note that` ·
`it's worth mentioning` · `at its core` · `in today's landscape` · `best practices` ·
`cutting-edge` · `game-changing` · `simply` · `just` · `easily` · `powerful` · `rich`

**Empty intensifiers on your own work.** Do not call your change robust, thorough, clean, or
elegant. State what it does; let the reader judge.

**Hedge stacking.** One qualifier is honest, three are cowardice. "This may potentially help in
some cases" → say what it does, and separately say what it does not cover.

**Symmetry padding.** Rule-of-three triads (`fast, simple, and reliable`), paired clauses that
restate each other, and "not only X but also Y" are rhythm standing in for content.

**Bold-everything.** If four phrases per paragraph are bold, none are. Bold marks the one term a
scanning reader must not miss.

**Emoji.** None. Not in commits, comments, docs, headings, tool descriptions, or contract text. The
repo has zero and stays that way.

**Closing summaries.** A short document does not need a "Summary" or "Conclusion" restating itself.
End when you are done.

**False completion.** Never write "verified", "tested", "all passing", or "works" for something you
did not run. If tests failed, say so and paste the output. If a step was skipped, say which.

## Em dashes: this repo uses them, correctly

Do not cargo-cult a ban. The house style uses `—` for appositives and for cross-references, tightly
bound to the clause it modifies:

> The agent is pedagogy only — it never parses markdown.

That earns its dash: it appends the consequence the sentence needs. What is banned is the
*decorative* dash — one per sentence, three per paragraph, used where a comma or full stop belongs.

## Code comments

The house pattern is **invariant-and-hazard**: a comment exists to state the rule the code enforces,
or to record why the code looks strange, so the next reader does not "simplify" it back into a bug.

Good — states the invariant in one line, so the traversal direction is unarguable:

```ts
/** New prereq edge src->dst means "src requires dst". Cycle iff dst transitively requires src. */
```

Good — names the trap and why the workaround stops where it does:

```ts
// Best-effort strip of a frontmatter block when the YAML itself failed to parse. We only look
// for the literal `---` delimiters; if there's no closing delimiter we can't tell where the body
// starts, so return raw as-is.
```

Good — three words that prevent a whole class of bug:

```ts
// sources are file paths, not slugs — do not slugify them.
```

Slop — restates the line beneath it:

```ts
// Create the server
const server = new McpServer(...)
// Loop through the pages
for (const p of pages.values()) {
```

Rules:
- Comment the **why**, never the **what**. The code already says what.
- Prefer a comment that would stop a future refactor from reintroducing a bug.
- Record deviations from the design spec honestly, with how you verified.
- Never annotate authorship or recency: no `// NEW:`, `// Added per request`, `// Updated`,
  `// AI-generated`. Git owns that.
- Do not leave commented-out code. Delete it.

## Tool descriptions and contract text

This repo's most-read prose is not the README — it is the `description` on each MCP tool and the
contract strings a model executes (`VERIFY_CONTRACT`, `COMPILE_CONTRACT`). An agent acts on these,
so vagueness becomes wrong behavior.

The bar, from `link_pages`:

> Add a verified typed link src->dst with a one-line rationale naming what breaks/enriches without it.

That is one sentence naming the action, the shape, and the acceptance test. Hold new tool
descriptions to it:

- Say what the tool returns, not that it "helps you" do something.
- State the obligation the caller takes on, imperatively (`You MUST verify...`, `Call at session
  start.`).
- Name the rejection rule where one exists (`Silently drop candidates you cannot justify.`).
- No hedging. An agent cannot act on "may be useful in some cases".

## Commit messages

This repo uses conventional prefixes (`feat:`, `fix:`, `docs:`) and the subject must name the
*mechanism*, not the vibe. Real examples from this log:

```
feat: teaching tools (compile, paths, student model) and stdio entrypoint
fix: next_lessons always wraps response as {lessons, note?}
feat: add lw.mjs, a tiny CLI client for driving the MCP server
```

Slop equivalents to avoid: `fix: various improvements`, `refactor: improve code quality`,
`feat: add new functionality`, `chore: cleanup`.

Body (when one is needed): why the change was necessary, and what a reader would otherwise get
wrong. Not a bulleted restatement of the diff.

## PR bodies

Describe the change and its risk. No "Summary / Changes / Testing" scaffold unless the repo template
asks for it. No emoji headers. If you did not run the tests, the Testing section says which ones you
did not run.

## Self-check before writing prose out

1. Delete every sentence whose removal loses no information. Is anything left?
2. Search your draft for the filler list above. Zero hits?
3. Does any sentence claim work you did not do?
4. Would a busy engineer who knows this codebase learn something in the first ten words?
