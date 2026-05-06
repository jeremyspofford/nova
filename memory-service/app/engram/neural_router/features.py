"""Feature extraction for Neural Router re-ranker.

Converts spreading activation candidates into tensors suitable for
ScalarReranker and EmbeddingReranker forward passes.
"""

from __future__ import annotations

from datetime import datetime, timezone

import torch

from . import ENGRAM_TYPES

_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def extract_scalar_features(
    candidates: list[dict],
    temporal_context: dict,
) -> torch.Tensor:
    """Extract scalar features from candidates.

    Args:
        candidates: List of candidate dicts from spreading activation.
            Each dict has: cosine_similarity, importance, activation,
            last_accessed, type, convergence_paths, outcome_avg, outcome_count.
        temporal_context: Dict with time_of_day (float 0-1),
            day_of_week (str), active_goal (str or empty).

    Returns:
        (n_candidates, 25) float32 tensor.
    """
    now = datetime.now(timezone.utc)
    time_of_day = temporal_context.get("time_of_day", 0.0)
    # Handle legacy string format "HH:MM"
    if isinstance(time_of_day, str):
        try:
            parts = time_of_day.split(":")
            time_of_day = int(parts[0]) / 24 + int(parts[1]) / 1440
        except (ValueError, IndexError):
            time_of_day = 0.0

    day_str = temporal_context.get("day_of_week", "Monday")
    day_onehot = [1.0 if d == day_str else 0.0 for d in _DAYS]
    has_goal = 1.0 if temporal_context.get("active_goal") else 0.0

    rows = []
    for c in candidates:
        # Recency in days (capped at 365, default 0 if no last_accessed)
        last_acc = c.get("last_accessed")
        if last_acc is not None:
            if isinstance(last_acc, str):
                try:
                    last_acc = datetime.fromisoformat(last_acc)
                except (ValueError, TypeError):
                    last_acc = None
            if last_acc is not None:
                delta = (now - last_acc).total_seconds() / 86400.0
                recency = min(delta, 365.0)
            else:
                recency = 0.0
        else:
            recency = 0.0

        # Type one-hot
        engram_type = c.get("type", "fact")
        type_onehot = [1.0 if t == engram_type else 0.0 for t in ENGRAM_TYPES]

        row = [
            float(c.get("cosine_similarity", 0.0)),
            float(c.get("importance", 0.5)),
            float(c.get("activation", 0.0)),
            recency,
            *type_onehot,
            float(time_of_day),
            *day_onehot,
            has_goal,
            float(c.get("convergence_paths", 0)),
            float(c.get("outcome_avg", 0.0) or 0.0),
            float(c.get("outcome_count", 0)),
        ]
        rows.append(row)

    return torch.tensor(rows, dtype=torch.float32) if rows else torch.zeros(0, 25)


def extract_embedding_features(
    query_embedding: list[float],
    candidate_embeddings: list[list[float]],
) -> tuple[torch.Tensor, torch.Tensor]:
    """Extract embedding features for EmbeddingReranker.

    Args:
        query_embedding: 768-dim query embedding vector.
        candidate_embeddings: List of 768-dim engram embedding vectors.

    Returns:
        Tuple of (query_tensor, engram_tensor):
        - query_tensor: (n_candidates, 768) — query repeated per candidate
        - engram_tensor: (n_candidates, 768)
    """
    n = len(candidate_embeddings)
    if n == 0:
        return torch.zeros(0, 768), torch.zeros(0, 768)

    q_tensor = torch.tensor([query_embedding] * n, dtype=torch.float32)
    e_tensor = torch.tensor(candidate_embeddings, dtype=torch.float32)
    return q_tensor, e_tensor
