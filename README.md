# Loreweaver

Teaching-memory MCP server: an Obsidian-compatible markdown vault of linked concept
pages, curated learning paths ("rabbit holes"), and a persistent evidence-graded
student model — so any MCP agent can tutor with durable memory of both the subject
and the student.

## Quick start

```bash
npm install
LOREWEAVER_VAULT=/path/to/vault npm start
```

Vault layout (created on demand):

```
vault/
  pages/<domain>/<slug>.md   # one concept per file; [[wiki-links]] + typed frontmatter edges
  paths/<slug>.md            # curated rabbit holes (ordered pages + narrative)
  students/<name>.json       # evidence-graded mastery with read-time decay
  raw/                       # sources awaiting compilation
  review-log.md              # every accepted link with its rationale
```

## Claude Code config (`.mcp.json`)

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

## Embeddings

`LOREWEAVER_EMBEDDINGS` = `ollama` (default; needs `ollama pull nomic-embed-text`),
`fake` (deterministic, for tests), `none` (lexical-only degradation).

## Teaching

Give your agent `docs/tutor-prompt.md` as its system prompt / skill.
Design spec: `docs/superpowers/specs/2026-07-10-loreweaver-design.md`.

## Tests

```bash
npm test
```
