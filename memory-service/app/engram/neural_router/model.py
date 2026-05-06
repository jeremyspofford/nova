"""PyTorch model definitions for the Neural Router re-ranker.

Two architectures, auto-selected based on observation count:
- ScalarReranker: 25 scalar features -> relevance score (200-999 obs)
- EmbeddingReranker: scalar features + embedding projections (1000+ obs)
"""

from __future__ import annotations

import torch
import torch.nn as nn


class ScalarReranker(nn.Module):
    """Small MLP re-ranker using only scalar features (~4K params).

    Input: 25 scalar features per candidate
    Output: relevance probability (0-1) per candidate
    """

    SCALAR_DIM = 25

    def __init__(self) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(self.SCALAR_DIM, 64),
            nn.ReLU(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
            nn.Sigmoid(),
        )

    def forward(self, scalar_features: torch.Tensor) -> torch.Tensor:
        """Forward pass.

        Args:
            scalar_features: (batch, 25) tensor of scalar features

        Returns:
            (batch, 1) tensor of relevance scores
        """
        return self.net(scalar_features)


class EmbeddingReranker(nn.Module):
    """MLP re-ranker with embedding projection layers (~57K params).

    Adds learned 768->32 projections for query and engram embeddings,
    computing dot product and element-wise difference as interaction features.

    Input: 25 scalar features + 768-dim query embedding + 768-dim engram embedding
    Output: relevance probability (0-1) per candidate
    """

    SCALAR_DIM = 25
    EMBED_DIM = 768
    PROJECT_DIM = 32

    def __init__(self) -> None:
        super().__init__()
        self.query_proj = nn.Linear(self.EMBED_DIM, self.PROJECT_DIM)
        self.engram_proj = nn.Linear(self.EMBED_DIM, self.PROJECT_DIM)

        # scalar(25) + dot(1) + diff(32) = 58
        combined_dim = self.SCALAR_DIM + 1 + self.PROJECT_DIM
        self.net = nn.Sequential(
            nn.Linear(combined_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
            nn.Sigmoid(),
        )

    def forward(
        self,
        scalar_features: torch.Tensor,
        query_embedding: torch.Tensor,
        engram_embeddings: torch.Tensor,
    ) -> torch.Tensor:
        """Forward pass.

        Args:
            scalar_features: (batch, 25) tensor of scalar features
            query_embedding: (batch, 768) tensor of query embeddings
            engram_embeddings: (batch, 768) tensor of engram embeddings

        Returns:
            (batch, 1) tensor of relevance scores
        """
        q_proj = self.query_proj(query_embedding)  # (batch, 32)
        e_proj = self.engram_proj(engram_embeddings)  # (batch, 32)

        dot = (q_proj * e_proj).sum(dim=1, keepdim=True)  # (batch, 1)
        diff = q_proj - e_proj  # (batch, 32)

        combined = torch.cat([scalar_features, dot, diff], dim=1)
        return self.net(combined)
