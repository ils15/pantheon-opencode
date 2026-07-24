"""RAG pipeline — orchestrates chunking, embedding, retrieval, and context assembly.

End-to-end pipeline that:
1. Ingests PDF documents (chunk + embed + index)
2. Processes queries (embed → search → format context)
"""

from typing import Any

from chunker import Chunker
from vector_store import VectorStore


class RAGPipeline:
    """Retrieval-Augmented Generation pipeline.

    Args:
        chunker: A Chunker instance for PDF parsing.
        vector_store: A VectorStore instance for embedding + search.

    Example:
        >>> chunker = Chunker(chunk_size=500, overlap=50)
        >>> vs = VectorStore()
        >>> pipeline = RAGPipeline(chunker=chunker, vector_store=vs)
        >>> pipeline.ingest("document.pdf")
        12
        >>> result = pipeline.process_query("machine learning", k=3)
        >>> result["query"]
        'machine learning'
    """

    def __init__(
        self,
        chunker: Chunker | None = None,
        vector_store: VectorStore | None = None,
    ) -> None:
        self.chunker = chunker or Chunker()
        self.vector_store = vector_store or VectorStore()

    def ingest(self, pdf_path: str) -> int:
        """Ingest a PDF: chunk it, embed it, and index it.

        Args:
            pdf_path: Path to the PDF file.

        Returns:
            Number of chunks indexed.
        """
        chunks = self.chunker.chunk(pdf_path)
        self.vector_store.add_documents(chunks)
        return len(chunks)

    def process_query(self, query: str, k: int = 3) -> dict[str, Any]:
        """Process a query through the RAG pipeline.

        Args:
            query: The user query string.
            k: Number of chunks to retrieve.

        Returns:
            Dict with:
                - query: The original query.
                - context: Concatenated text from retrieved chunks.
                - sources: List of chunk dicts with metadata + scores.
        """
        results = self.vector_store.search(query, k=k)

        if not results:
            return {"query": query, "context": "", "sources": []}

        context_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        for rank, result in enumerate(results, 1):
            source_text = result["text"]
            context_parts.append(
                f"[Source {rank} (page {result['source_page']}, "
                f"similarity: {result['score']:.3f})]\n{source_text}"
            )
            sources.append(result)

        context = "\n\n".join(context_parts)

        return {
            "query": query,
            "context": context,
            "sources": sources,
        }
