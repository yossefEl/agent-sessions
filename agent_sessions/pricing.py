"""Model pricing and cost estimation.

Prices are USD per million tokens, at published API list rates. Claude Code
usage on a subscription plan is NOT billed per token, so treat every cost in
this tool as "what these tokens would cost at API list rates", not as a bill.

Override or extend the table by creating a JSON file next to the database:

    ~/.agent-sessions/prices.json
    {
      "gpt-5.6-sol": {"input": 1.25, "output": 10.0},
      "my-model":    {"input": 0.5,  "output": 1.5}
    }

Any model with no entry is treated as unpriced: its tokens are still counted,
but it contributes nothing to cost totals and is reported separately.
"""

from __future__ import annotations

import json
import os

# Cache multipliers, relative to the model's input price.
CACHE_READ_MULT = 0.1
CACHE_WRITE_5M_MULT = 1.25
CACHE_WRITE_1H_MULT = 2.0

# USD per million tokens. Anthropic first-party API list rates.
# Matched by longest-prefix against the model id recorded in the session.
CLAUDE_PRICES: dict[str, dict[str, float]] = {
    "claude-fable-5": {"input": 10.0, "output": 50.0},
    "claude-mythos-5": {"input": 10.0, "output": 50.0},
    "claude-mythos-preview": {"input": 10.0, "output": 50.0},
    "claude-opus-5": {"input": 5.0, "output": 25.0},
    "claude-opus-4-8": {"input": 5.0, "output": 25.0},
    "claude-opus-4-7": {"input": 5.0, "output": 25.0},
    "claude-opus-4-6": {"input": 5.0, "output": 25.0},
    "claude-opus-4-5": {"input": 5.0, "output": 25.0},
    "claude-opus-4-1": {"input": 15.0, "output": 75.0},
    "claude-opus-4": {"input": 15.0, "output": 75.0},
    "claude-sonnet-5": {"input": 3.0, "output": 15.0},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0},
    "claude-sonnet-4": {"input": 3.0, "output": 15.0},
    "claude-3-7-sonnet": {"input": 3.0, "output": 15.0},
    "claude-3-5-sonnet": {"input": 3.0, "output": 15.0},
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0},
    "claude-3-5-haiku": {"input": 0.8, "output": 4.0},
    "claude-3-haiku": {"input": 0.25, "output": 1.25},
}

# Deliberately empty: this tool does not ship guessed OpenAI/Codex prices.
# Add them yourself in prices.json and Codex sessions start reporting cost.
CODEX_PRICES: dict[str, dict[str, float]] = {}

_DEFAULT_PRICES = {**CLAUDE_PRICES, **CODEX_PRICES}


def load_prices(overrides_path: str | None = None) -> dict[str, dict[str, float]]:
    """Built-in table merged with the user's prices.json, if present."""
    prices = dict(_DEFAULT_PRICES)
    if overrides_path and os.path.exists(overrides_path):
        try:
            with open(overrides_path) as fh:
                user = json.load(fh)
            for model, entry in user.items():
                if isinstance(entry, dict) and "input" in entry and "output" in entry:
                    prices[model] = {
                        "input": float(entry["input"]),
                        "output": float(entry["output"]),
                    }
        except (OSError, ValueError):
            pass
    return prices


def price_for(model: str | None, prices: dict[str, dict[str, float]]):
    """Longest-prefix match, so dated snapshots resolve to their family."""
    if not model:
        return None
    if model in prices:
        return prices[model]
    best = None
    for key, entry in prices.items():
        if model.startswith(key) and (best is None or len(key) > len(best[0])):
            best = (key, entry)
    return best[1] if best else None


def estimate_cost(model, usage, prices) -> float | None:
    """USD for one usage record, or None when the model has no price entry.

    `usage` keys (all optional): input, output, cache_read,
    cache_write_5m, cache_write_1h, cache_write (untyped fallback).
    """
    entry = price_for(model, prices)
    if entry is None:
        return None
    inp = entry["input"] / 1_000_000
    out = entry["output"] / 1_000_000

    cost = usage.get("input", 0) * inp + usage.get("output", 0) * out
    cost += usage.get("cache_read", 0) * inp * CACHE_READ_MULT
    cost += usage.get("cache_write_5m", 0) * inp * CACHE_WRITE_5M_MULT
    cost += usage.get("cache_write_1h", 0) * inp * CACHE_WRITE_1H_MULT
    # Cache writes whose TTL we could not determine: price at the 5m rate.
    cost += usage.get("cache_write", 0) * inp * CACHE_WRITE_5M_MULT
    return cost
