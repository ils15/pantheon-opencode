"""In-memory FAISS vector store for semantic search.

Uses sentence-transformers (all-MiniLM-L6-v2) for embedding generation and
FAISS for efficient similarity search with cosine similarity.
"""

from typing import Any

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer


class VectorStore:
    """In-memory FAISS vector store with cosine similarity search.

    Stores document chunks alongside their embeddings and metadata.

    Example:
        >>> vs = VectorStore()
        >>> chunks = [{"text": "AI is transforming tech.", "source_page": 1, "chunk_index": 0}]
        >>> vs.add_documents(chunks)
        >>> results = vs.search("artificial intelligence", k=3)
    """

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        self.model = SentenceTransformer(model_name)
        self.dimension: int = self.model.get_embedding_dimension()
        self.index: faiss.Index | None = None
        self.documents: list[dict[str, Any]] = []

    def add_documents(self, chunks: list[dict[str, Any]]) -> None:
        """Add document chunks to the vector store.

        Args:
            chunks: List of dicts with at least a "text" key.
                    Other keys (source_page, chunk_index) are preserved as metadata.
        """
        if not chunks:
            return

        texts = [chunk["text"] for chunk in chunks]
        embeddings = self.model.encode(
            texts, convert_to_numpy=True, show_progress_bar=False
        )

        # Normalize embeddings for cosine similarity
        faiss.normalize_L2(embeddings)

        if self.index is None:
            self.index = faiss.IndexFlatIP(self.dimension)

        self.index.add(embeddings)
        self.documents.extend(chunks)

    def search(self, query: str, k: int = 3) -> list[dict[str, Any]]:
        """Search for top-k most similar chunks by cosine similarity.

        Args:
            query: The search query string.
            k: Number of results to return.

        Returns:
            List of dicts with chunk metadata + 'score' (cosine similarity 0-1).
            Empty list if no documents indexed.
        """
        if self.index is None or self.index.ntotal == 0:
            return []

        query_embedding = self.model.encode(
            [query], convert_to_numpy=True, show_progress_bar=False
        )
        faiss.normalize_L2(query_embedding)

        actual_k = min(k, self.index.ntotal)
        distances, indices = self.index.search(query_embedding, actual_k)

        results: list[dict[str, Any]] = []
        for rank in range(actual_k):
            idx = int(indices[0][rank])
            score = float(distances[0][rank])
            # Clamp cosine similarity to [0, 1] range
            score = max(0.0, min(1.0, score))

            chunk = self.documents[idx].copy()
            chunk["score"] = score
            results.append(chunk)

        return results
