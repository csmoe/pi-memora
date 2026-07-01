#!/usr/bin/env python3
"""JSON CLI bridge between a Pi TypeScript extension and Microsoft Memora."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
import types
from importlib.machinery import ModuleSpec
from pathlib import Path
from typing import Any


def _json_out(payload: dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def _read_payload() -> dict[str, Any]:
    if len(sys.argv) >= 3:
        raw = sys.argv[2]
    else:
        raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _setup_commands() -> list[str]:
    project_root = Path(__file__).resolve().parent.parent
    memora_repo = project_root / "vendor" / "Memora"
    memora_ref = "dec3f8f2444eace7004fc084abe1be9f3d88270e"
    return [
        f"MEMORA_REPO=\"{memora_repo}\"",
        "mkdir -p \"$(dirname \"$MEMORA_REPO\")\"",
        "git init \"$MEMORA_REPO\"",
        "git -C \"$MEMORA_REPO\" remote add origin https://github.com/microsoft/Memora.git",
        f"git -C \"$MEMORA_REPO\" fetch --depth 1 origin {memora_ref}",
        "git -C \"$MEMORA_REPO\" checkout --detach FETCH_HEAD",
        f"uv run --project \"{project_root}\" python -c \"import sys; print(sys.version)\"",
    ]


def _add_default_memora_checkout_to_path() -> None:
    project_root = Path(__file__).resolve().parent.parent
    memora_src = project_root / "vendor" / "Memora" / "src"
    if memora_src.exists():
        sys.path.insert(0, str(memora_src))


def _openai_compat_base_url(kind: str) -> str | None:
    if kind == "EMBEDDING":
        return os.getenv("PI_MEMORA_EMBEDDING_BASE_URL") or os.getenv("OPENAI_EMBEDDING_BASE_URL") or os.getenv("OPENROUTER_EMBEDDING_BASE_URL")
    return os.getenv("OPENAI_BASE_URL") or os.getenv("OPENROUTER_BASE_URL")


def _openai_compat_api_key(kind: str) -> str | None:
    if kind == "EMBEDDING":
        return os.getenv("PI_MEMORA_EMBEDDING_API_KEY") or os.getenv("OPENAI_EMBEDDING_API_KEY") or os.getenv("OPENROUTER_API_KEY") or os.getenv("OPENAI_API_KEY")
    return os.getenv("OPENAI_API_KEY") or os.getenv("OPENROUTER_API_KEY")


def _apply_openai_compat_patches() -> None:
    from openai import OpenAI
    import memora.utils.embedding as embedding_utils
    import memora.utils.llm as llm_utils

    def get_openai_chat_completion_client(cfg):
        api_key = cfg.openai.get("api_key", None) or _openai_compat_api_key("LLM")
        if not api_key:
            raise ValueError("OpenAI-compatible chat API key is missing.")
        kwargs: dict[str, str] = {"api_key": api_key}
        base_url = cfg.openai.get("llm_api_base", None) or _openai_compat_base_url("LLM")
        if base_url:
            kwargs["base_url"] = base_url
        return OpenAI(**kwargs)

    def get_openai_embedding_client(cfg):
        api_key = cfg.openai.get("embedding_api_key", None) or _openai_compat_api_key("EMBEDDING")
        if not api_key:
            raise ValueError("OpenAI-compatible embedding API key is missing.")
        kwargs: dict[str, str] = {"api_key": api_key}
        base_url = cfg.openai.get("embedding_api_base", None) or _openai_compat_base_url("EMBEDDING")
        if base_url:
            kwargs["base_url"] = base_url
        return OpenAI(**kwargs)

    embedding_utils.get_openai_embedding_client = get_openai_embedding_client
    llm_utils.get_openai_chat_completion_client = get_openai_chat_completion_client

    llm_utils.ChatCompletionModel._determine_model_type = lambda self, model_name: "openai"

    original_invoke_openai = llm_utils.ChatCompletionModel._invoke_azure

    def invoke_openai_compat(self, messages, response_format, source, **kwargs):
        kwargs.setdefault("max_tokens", 2048)
        return original_invoke_openai(self, messages, response_format, source, **kwargs)

    llm_utils.ChatCompletionModel._invoke_azure = invoke_openai_compat


def _install_optional_dependency_shims() -> None:
    """Avoid installing local-HF/GRPO dependencies for remote OpenAI-compatible use."""
    if importlib.util.find_spec("torch") is None:
        torch = types.ModuleType("torch")
        torch.__spec__ = ModuleSpec("torch", loader=None)
        torch.bfloat16 = "bfloat16"
        torch.float16 = "float16"
        torch.float32 = "float32"
        torch.manual_seed = lambda *_args, **_kwargs: None
        torch.no_grad = lambda: _NoopContext()
        torch.cuda = types.SimpleNamespace(
            is_available=lambda: False,
            manual_seed_all=lambda *_args, **_kwargs: None,
        )
        sys.modules["torch"] = torch

    if importlib.util.find_spec("transformers") is None:
        transformers = types.ModuleType("transformers")
        transformers.__spec__ = ModuleSpec("transformers", loader=None)
        transformers.AutoModelForCausalLM = _UnavailableOptionalDependency("transformers")
        transformers.AutoTokenizer = _UnavailableOptionalDependency("transformers")
        transformers.BitsAndBytesConfig = _UnavailableOptionalDependency("transformers")
        sys.modules["transformers"] = transformers

    if importlib.util.find_spec("peft") is None:
        peft = types.ModuleType("peft")
        peft.__spec__ = ModuleSpec("peft", loader=None)
        peft.PeftModel = _UnavailableOptionalDependency("peft")
        sys.modules["peft"] = peft


class _NoopContext:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _UnavailableOptionalDependency:
    def __init__(self, package: str):
        self.package = package

    def __getattr__(self, _name: str):
        raise ImportError(f"Optional dependency '{self.package}' is not installed.")

    def __call__(self, *_args, **_kwargs):
        raise ImportError(f"Optional dependency '{self.package}' is not installed.")


def _memora_imports():
    if sys.version_info < (3, 10):
        _json_out(
            {
                "ok": False,
                "error": "Memora requires Python 3.10 or newer.",
                "detail": f"Current Python is {sys.version.split()[0]} at {sys.executable}",
                "setup": _setup_commands(),
            },
            code=2,
        )
    try:
        _add_default_memora_checkout_to_path()
        _install_optional_dependency_shims()
        _apply_openai_compat_patches()
        from memora.memora_client import MemoraClient
        from omegaconf import OmegaConf
    except Exception as exc:  # pragma: no cover - environment dependent
        _json_out(
            {
                "ok": False,
                "error": "Memora is not importable in this Python environment.",
                "detail": str(exc),
                "setup": _setup_commands(),
            },
            code=2,
        )
    return MemoraClient, OmegaConf


def _default_home() -> Path:
    configured = os.getenv("PI_MEMORA_HOME")
    if configured:
        return Path(configured).expanduser()
    data_home = os.getenv("XDG_DATA_HOME")
    if data_home:
        return Path(data_home).expanduser() / "pi-memora"
    return Path.home() / ".local" / "share" / "pi-memora"


def _scope_id(payload: dict[str, Any]) -> str:
    scope = os.getenv("PI_MEMORA_SCOPE", "project")
    if scope == "global":
        return "pi-global"
    cwd = str(payload.get("cwd") or os.getcwd())
    digest = hashlib.sha256(cwd.encode("utf-8")).hexdigest()[:16]
    return f"pi-project-{digest}"


def _cfg(payload: dict[str, Any]):
    _, OmegaConf = _memora_imports()
    home = _default_home()
    store = home / "store"
    store.mkdir(parents=True, exist_ok=True)

    api_type = os.getenv("OPENAI_API_TYPE")
    if not api_type:
        api_type = "openai" if os.getenv("OPENAI_API_KEY") else "azure"

    model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    embedding_model = os.getenv("PI_MEMORA_EMBEDDING_MODEL", os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"))
    collection = "pi_agent_memory"
    persist_path = str(store / collection)

    return OmegaConf.create(
        {
            "llm": {"model": model, "seed": 42},
            "openai": {
                "api_type": api_type,
                "llm_api_base": os.getenv("AZURE_OPENAI_ENDPOINT", "") if api_type == "azure" else (_openai_compat_base_url("LLM") or ""),
                "llm_api_version": os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview"),
                "embedding_api_base": os.getenv("AZURE_OPENAI_ENDPOINT", "") if api_type == "azure" else (_openai_compat_base_url("EMBEDDING") or ""),
                "embedding_api_version": os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview"),
                "embedding_deployment_name": os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", embedding_model),
                "managed_identity": os.getenv("AZURE_MANAGED_IDENTITY_CLIENT_ID"),
                "api_key": _openai_compat_api_key("LLM"),
                "embedding_api_key": _openai_compat_api_key("EMBEDDING"),
                "embedding_model": embedding_model,
                "model": model,
            },
            "memory": {
                "memory_store": "pi_memora",
                "persist_path": persist_path,
                "collection_name": collection,
                "distance": "cosine",
                "query_score_threshold": 0.4,
                "update_score_threshold": 0.8,
                "force_rebuild": False,
                "enhance_query": False,
                "return_history": True,
                "multimodal_support": False,
                "top_k": int(os.getenv("PI_MEMORA_TOP_K", "5")),
                "cue_top_k": 10,
                "enable_hybrid_search": True,
                "enable_segmentation": False,
                "enable_episodic_memory": False,
                "use_segments_as_episodic": False,
                "enable_cue_index": True,
            },
            "retrieval": {"strategy": "semantic"},
            "eval": {"max_workers": 2},
        }
    )


def _client(payload: dict[str, Any]):
    MemoraClient, _ = _memora_imports()
    return MemoraClient(cfg=_cfg(payload), user_id=_scope_id(payload))


def _entry_to_dict(entry: Any) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for key in ("index", "value", "primary_abstraction", "cue_anchors", "metadata", "score"):
        if hasattr(entry, key):
            try:
                data[key] = getattr(entry, key)
            except Exception:
                pass
    if not data:
        data["value"] = str(entry)
    return data


def _metadata(payload: dict[str, Any]) -> dict[str, Any]:
    metadata = dict(payload.get("metadata") or {})
    for key in ("cwd", "session", "source"):
        value = payload.get(key)
        if value:
            metadata[key] = value
    return metadata


def main() -> None:
    action = sys.argv[1] if len(sys.argv) >= 2 else "doctor"
    payload = _read_payload()

    try:
        if action == "missing-setup":
            _json_out(
                {
                    "ok": False,
                    "error": "Memora checkout is missing or incomplete.",
                    "setup": _setup_commands(),
                },
                code=2,
            )

        if action == "doctor":
            client = _client(payload)
            _json_out(
                {
                    "ok": True,
                    "user_id": _scope_id(payload),
                    "count": client.count(),
                    "home": str(_default_home()),
                }
            )

        if action == "add":
            text = str(payload.get("text") or "").strip()
            if not text:
                _json_out({"ok": False, "error": "No text provided."}, code=1)
            entries = _client(payload).add(text, type=str(payload.get("type") or "doc"), metadata=_metadata(payload))
            _json_out({"ok": True, "stored": len(entries), "entries": [_entry_to_dict(e) for e in entries]})

        if action == "query":
            query = str(payload.get("query") or "").strip()
            if not query:
                _json_out({"ok": False, "error": "No query provided."}, code=1)
            top_k = int(payload.get("top_k") or os.getenv("PI_MEMORA_TOP_K", "5"))
            strategy = str(payload.get("strategy") or "semantic")
            client = _client(payload)
            if strategy == "semantic":
                entries = client.query(query, top_k=top_k, enable_hybrid_search=True)
            else:
                entries = client.advance_query(query, top_k=top_k, query_type=strategy)
            _json_out({"ok": True, "entries": [_entry_to_dict(e) for e in entries]})

        if action == "list":
            limit = int(payload.get("limit") or 20)
            entries = _client(payload).list_memories(limit=limit)
            _json_out({"ok": True, "entries": [_entry_to_dict(e) for e in entries]})

        if action == "delete":
            key = str(payload.get("key") or "").strip()
            if not key:
                _json_out({"ok": False, "error": "No key provided."}, code=1)
            _client(payload).delete(key)
            _json_out({"ok": True})

        if action == "clear":
            if payload.get("confirm") != "clear":
                _json_out({"ok": False, "error": "Refusing to clear without confirm='clear'."}, code=1)
            _client(payload).clear()
            _json_out({"ok": True})

        _json_out({"ok": False, "error": f"Unknown action: {action}"}, code=1)
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover - integration diagnostics
        payload = {"ok": False, "error": str(exc)}
        _json_out(payload, code=1)


if __name__ == "__main__":
    main()
