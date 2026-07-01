# pi-memora

Persistent memory for the [Pi coding agent](https://pi.dev), backed by [Microsoft Memora](https://github.com/microsoft/Memora).

`pi-memora` is a Pi extension package. It adds memory tools, recalls relevant memories into the current turn, and can capture finished turns back into Memora.

## What It Adds

- `/memora` command for status, setup, recall, remember, list, and clear.
- `memora_remember` tool for durable facts, decisions, preferences, and task outcomes.
- `memora_recall` tool for semantic memory lookup.
- `memora_list` tool for inspecting stored memories.
- Optional automatic recall before each prompt.
- Optional automatic capture after each agent run.

The bridge is a uv project. Its Python dependencies live in `pyproject.toml`; it does not install Memora's full benchmark, RL, or local-Hugging-Face dependency set.

## Install

Global install:

```bash
pi install npm:pi-memora
```

Project-local install:

```bash
pi install npm:pi-memora -l
```

Local checkout:

```bash
pi install /path/to/pi-memora
```

One-session trial:

```bash
pi -e npm:pi-memora
```

If Pi is already running after installation, run `/reload` or start a new Pi session.

After installation, `/memora status` reports whether the Memora runtime is ready. `/memora setup` shows the exact setup commands for the installed package path.

## Memora Checkout

Memora is currently consumed as a pinned source checkout. Place it under the installed extension package at `vendor/Memora`.

Find the installed package path:

```bash
pi list
```

Then clone the pinned Memora commit:

```bash
PI_MEMORA_PACKAGE=/path/to/installed/pi-memora
MEMORA_REPO=$PI_MEMORA_PACKAGE/vendor/Memora

mkdir -p "$(dirname "$MEMORA_REPO")"
git init "$MEMORA_REPO"
git -C "$MEMORA_REPO" remote add origin https://github.com/microsoft/Memora.git
git -C "$MEMORA_REPO" fetch --depth 1 origin dec3f8f2444eace7004fc084abe1be9f3d88270e
git -C "$MEMORA_REPO" checkout --detach FETCH_HEAD
```

For local development, the package path is this repo:

```bash
PI_MEMORA_PACKAGE=/Users/mac/Documents/pi-memora
```

## Provider Setup

Memora's chat/extraction calls use Pi's active OpenAI-compatible model and Pi's resolved model auth. Configure the embedding model before launching Pi.

OpenAI:

```bash
export PI_MEMORA_EMBEDDING_MODEL=text-embedding-3-small
```

OpenRouter:

```bash
export PI_MEMORA_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
export PI_MEMORA_EMBEDDING_MODEL=qwen/qwen3-embedding-8b
```

If the embedding provider is different from Pi's active model provider, also set that provider's embedding API key, for example `PI_MEMORA_EMBEDDING_API_KEY` or `OPENROUTER_API_KEY`.

Azure OpenAI:

```bash
export OPENAI_API_TYPE=azure
export AZURE_OPENAI_ENDPOINT=...
export AZURE_OPENAI_API_VERSION=2024-12-01-preview
export AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
```

## Usage

```text
/memora status
/memora setup
/memora remember The project uses ChromaDB for local vector storage.
/memora recall repository architecture decisions
/memora list 10
/memora clear clear
```

The model may also call `memora_remember`, `memora_recall`, and `memora_list` directly.

## Configuration

Package-specific environment variables:

- `PI_MEMORA_HOME`: memory data root. Defaults to `${XDG_DATA_HOME:-$HOME/.local/share}/pi-memora`.
- `PI_MEMORA_SCOPE`: `project` or `global`. Defaults to `project`.
- `PI_MEMORA_AUTORECALL`: set to `0` to disable automatic recall.
- `PI_MEMORA_AUTOCAPTURE`: set to `0` to disable automatic capture.
- `PI_MEMORA_TOP_K`: recall count. Defaults to `5`.
- `PI_MEMORA_EMBEDDING_MODEL`: embedding model. Defaults to `text-embedding-3-small`.
- `PI_MEMORA_EMBEDDING_BASE_URL`: OpenAI-compatible embeddings base URL.
- `PI_MEMORA_EMBEDDING_API_KEY`: embeddings API key. Falls back to `OPENAI_EMBEDDING_API_KEY`, `OPENROUTER_API_KEY`, or `OPENAI_API_KEY`.

Provider-native variables such as `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, and `AZURE_OPENAI_ENDPOINT` are still used for embeddings when the embedding provider cannot use Pi's active model credential.

## Data And Safety

- Memory data is stored under `PI_MEMORA_HOME`.
- Memora source is checked out under `vendor/Memora` inside the installed package.
- The extension does not read env files or write shell configuration.
- Rotate any API key pasted into chat, logs, issue trackers, or support requests.
- Disable autocapture with `PI_MEMORA_AUTOCAPTURE=0` when working with secrets or private data.
- If you change embedding models, clear or rebuild the existing collection first. Vector dimensions may differ.

## Development

```bash
npm install
uv lock
npm test
npm pack --dry-run
```

Local extension smoke test:

```bash
export PI_MEMORA_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1
export PI_MEMORA_EMBEDDING_MODEL=qwen/qwen3-embedding-8b

pi -e ./extensions/memora.ts --no-builtin-tools --tools memora_recall -p "Use memora_recall to summarize pi-memora smoke test memory."
```
