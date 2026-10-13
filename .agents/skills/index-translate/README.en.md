# Wiring this proxy to an agent: the skill file and MCP

This folder holds **two things meant for an agent**: a skill (`SKILL.md` — when to use the translation service, how to call it, where it goes wrong) and how to wire up the MCP server that skill depends on.
Neither is part of the product: the files are here for a human to follow, and equally for an agent to follow on its own.

## What is here

- `SKILL.md`: the skill itself, in the shape of the [Agent Skills](https://agentskills.io/specification) spec (a directory plus frontmatter). pi and Agent-Skills-capable clients walk up from the working directory and find `.agents/skills/`, so **after cloning this repo the skill is usually already discovered** — no separate install step.
- `README.md`／`README.en.md`: this file. A human reads "three ways to wire it up" below; an agent reads the prompt in the next section.
- The MCP server itself lives in [`examples/mcp/`](../../../examples/mcp/README.md) in the same repo: `server.mjs`, `mcp.json.example` (values left empty).

## A prompt for your agent (paste it into your own agent)

The two language versions of this block are **byte-identical on purpose** — a prompt should exist once; translating it is how it starts drifting.

```text
You have a translation service available through this repo. Set it up, don't just read about it.

0. First check whether it is already wired up: search your tool list for a tool named "translate"
   (in pi: describeNamespace("mcp__index-translate") / searchTools("translate")). If the tools are
   there, skip to step 5.

1. Otherwise: read .agents/skills/index-translate/SKILL.md and examples/mcp/README.md.
2. Ask me for two values if you don't already have them: the base URL of MY OWN deployed instance,
   and its ITP_KEY. Prefer environment variables you can already see over asking.
3. Install the MCP server for THIS client (for pi: copy examples/mcp/server.mjs into
   ~/.pi/agent/mcp-servers/index-translate/, add an "index-translate" entry to
   ~/.pi/agent/mcp.json with env ITP_BASE/ITP_KEY, then reload). For other clients use the
   equivalent stdio server config. Do it in the client's own config location, not in this repo.
4. Secrets rule: never write ITP_KEY into source files, docs, commit messages, or any file git
   tracks. Put it in the client's config file or the environment. If a linter in this repo flags a
   key, that is intentional.
5. Verify before you trust it: run the server's handshake, then translate two numbered lines and
   check the line count came back as 2. If any step fails, say which step failed and stop; do not
   retry blindly.
6. Once it works: use its translate tool for prose (docs, comments, READMEs, commit messages),
   keep the numbered lines, and re-check the output yourself before landing it.
```

What it does: check first (so nothing gets installed twice) → get the values → install → keep the key inside its boundary → verify → only then actually use it.
Steps 0 and 5 are the point: **if the tools are not there, do not pretend it worked**, and **it is not wired up until it has been verified**.

## Three ways to wire it up

### 1. Skill only (an agent that already has MCP)

The skill is this directory. For pi, the personal location (usable across projects):

```bash
mkdir -p ~/.pi/agent/skills
cp -r .agents/skills/index-translate ~/.pi/agent/skills/
```

Project scope (only inside this repo): put the whole directory under the project's `.agents/skills/` — this repo already has it there, so cloning is the install.

### 2. MCP only (no skill wanted)

```bash
cd examples/mcp && npm install
cp mcp.json.example mcp.json      # 填入 ITP_BASE / ITP_KEY（mcp.json 已被 .gitignore 抵掉）
ITP_BASE=https://<your-url> ITP_KEY='<your ITP_KEY>' npm run handshake
```

For how the client config is written, see [`examples/mcp/README.md`](../../../examples/mcp/README.md) and [`examples/mcp/mcp.json.example`](../../../examples/mcp/mcp.json.example).

### 3. Both (a new agent from scratch)

Follow the prompt above, or walk its steps yourself. For pi the two steps are:

```bash
mkdir -p ~/.pi/agent/mcp-servers/index-translate
cp examples/mcp/server.mjs ~/.pi/agent/mcp-servers/index-translate/server.mjs
cd ~/.pi/agent/mcp-servers/index-translate && npm install
```

Then paste the contents of `examples/mcp/mcp.json.example` into the `servers` array of `~/.pi/agent/mcp.json`, fill in the values, and restart.

## How to tell it is wired up

```bash
# 1. handshake: two tools/list lines mean the server and the protocol are fine
cd examples/mcp && ITP_BASE=... ITP_KEY=... npm run handshake
```

Then call `index_translate_models` once from your client (it is answered locally by the proxy, so it costs no upstream quota) and one translation of two short numbered lines —
**the line count must come back as 2**. Only when both pass is it wired up. Fuller live probes: [`examples/mcp/README.md`](../../../examples/mcp/README.md)
and [`design/mcp-client.md`](../../../design/mcp-client.md).

## Boundaries to know before using it

- **You need your own deployment**: this project offers no shared instance and no demo key. `ITP_BASE` is the URL of a deployment you made.
- **The key lives in exactly three places**: the deployment platform's Secret, local config files git does not track (`~/.pi/agent/mcp.json`, `examples/mcp/mcp.json`), and the client's environment. No plaintext in the repo, and `npm run lint:secret` is what enforces that.
- **Long text has to be batched**: the output side has a ceiling (`max_tokens` 4096), and hitting it drops only the tail — but the tool states `truncated` and how many chunks were cut. That is detectable; do not assume you received a full translation.
- **This service does not downgrade and never retries on another model**: if the model you asked for is unavailable it errors, and the decision to switch is yours.
- Re-check translations yourself. It does not know a project's preferred wording; for bilingual documents run the project's own parity check afterwards (e.g. `npm run lint:readme`).

## Where each thing lives in the repo

- This directory: the skill itself plus this entry document — both humans and agents enter here. The root README only links here; it does not explain any of this twice.
- `examples/mcp/`: the MCP server code and the minimal wiring (no boundary conditions or pitfalls there — those are written once).
- [`design/mcp-client.md`](../../../design/mcp-client.md): the measurements and the reasoning behind it (including the before/after around that 25s ceiling, and the two paths for detecting truncation).
- A personal install location (for example `~/.pi/agent/skills/index-translate/`) is a **copy**; the master copy is here. Change this one, not the copy.
