# Loreweaver

**Teaching memory for MCP agents: a markdown vault of linked concepts and an evidence-graded
model of what each student has actually proven.**

[![ci](https://github.com/SabienNguyen/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/SabienNguyen/loreweaver/actions/workflows/ci.yml)

Any MCP agent that connects gets durable memory of both the **subject** (an Obsidian-compatible
vault of concept pages with typed prerequisite/deepens edges and curated learning paths) and the
**student** (per-student mastery that only changes through recorded evidence, and decays without
reinforcement). Loreweaver is designed to be the *single writer* of that state — clients read and
teach through its tools; nothing else touches the files.

The reference client is
[loreweaver-harness](https://github.com/SabienNguyen/loreweaver-harness), a full desktop tutor
built on this server — but the server assumes nothing about its client beyond MCP over stdio.

## The evidence model

- Mastery levels: `unseen → exposed → practicing → mastered` — they change **only** through
  `record_evidence`, never by presenting material.
- Mastery **decays**: `mastered` needs reinforcement within 45 days, `practicing` within 21 —
  and `rubric-passed` evidence within 14, the shortest window, because a rubric verdict is a
  model's judgment — or the *effective* level drops a rung (the raw level is kept for history).
- Evidence kinds: `exposed`, `explained-correctly`, `applied-correctly`, `rubric-passed` (a model
  judged produced work against an explicit rubric — essays, legal analysis — its own kind so it
  can never launder itself into applied evidence), `struggled`, and `misconception` (with a note;
  misconceptions are surfaced until explicitly resolved).

## Tool surface

| Graph | Teaching |
|---|---|
| `list_pages` — every page's metadata in one call | `compile_source` — turn raw material into linked pages |
| `search` — lexical + semantic over the vault | `list_paths` / `read_path` / `create_path` — curated syllabi |
| `read_page` / `write_page` — one concept per page | `get_student_state` — the whole mastery map |
| `link_pages` / `unlink_pages` — typed edges (`prereq`, `deepens`, `related`), cycle-checked | `record_evidence` — the only door mastery moves through |
| | `next_lessons` — what this student should meet next |
| | `find_analogies` — bridges from what they already own |

Writes are conservative on purpose: `write_page` proposes links back to the caller for
verification rather than inventing edges, `link_pages` refuses cycles, and every accepted link
lands in `review-log.md` with its rationale.

## Quick start

```bash
npm install
LOREWEAVER_VAULT=/path/to/vault npm start
```

The vault is plain markdown, created on demand, and readable in Obsidian as-is:

```
vault/
  pages/<domain>/<slug>.md   # one concept per file; [[wiki-links]] + typed frontmatter edges
  paths/<slug>.md            # curated learning paths (ordered pages + narrative)
  students/<name>.json       # evidence-graded mastery with read-time decay
  raw/                       # sources awaiting compilation
  review-log.md              # every accepted link with its rationale
```

### As an MCP server (`.mcp.json`)

```json
{
  "mcpServers": {
    "loreweaver": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/loreweaver/src/server.ts"],
      "env": { "LOREWEAVER_VAULT": "/absolute/path/to/vault" }
    }
  }
}
```

### Embeddings

`LOREWEAVER_EMBEDDINGS` = `ollama` (default; needs `ollama pull nomic-embed-text`), `fake`
(deterministic, for tests), or `none`. Degradation is quiet: without embeddings, `search` and
`find_analogies` fall back to lexical matching rather than failing.

## Teaching with it

Give your agent `docs/tutor-prompt.md` as its system prompt or skill — it encodes the teaching
discipline the tools assume (present, check, record; never promote from recall alone). The full
design rationale lives in `docs/superpowers/specs/2026-07-10-loreweaver-design.md`.

## Tests

```bash
npm test        # 84 tests, including a seeded fuzz suite over the page parser
```

CI builds and runs the full suite on every push. The page parser — the surface compiled,
model-authored markdown lands on — is fuzzed with hostile input (broken YAML, frontmatter
near-misses, malformed wiki links) asserting it never throws, warned pages never present as
`solid`, and parse → serialize → parse is a fixed point.
