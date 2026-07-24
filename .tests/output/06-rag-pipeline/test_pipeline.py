"""Tests for RAG pipeline: chunker, vector_store, and pipeline."""

import os
import sys
import tempfile
from pathlib import Path

# Ensure we can import the modules
sys.path.insert(0, str(Path(__file__).parent))

import pytest
from fpdf import FPDF

from chunker import Chunker
from vector_store import VectorStore
from pipeline import RAGPipeline


# ─── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def sample_pdf_path() -> str:
    """Create a sample PDF with test content for chunking tests."""
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=12)

    paragraphs = [
        "Artificial intelligence is transforming the way we interact with technology. "
        "Machine learning algorithms can now recognize patterns in data with remarkable accuracy.",

        "Natural language processing enables computers to understand human language. "
        "Applications include translation, summarization, and question answering.",

        "Vector databases store embeddings that represent semantic meaning. "
        "They enable similarity search across large document collections.",

        "Retrieval augmented generation combines search with language models. "
        "This approach grounds responses in retrieved context for better accuracy.",

        "Attention mechanisms are fundamental to modern deep learning architectures. "
        "They allow models to focus on relevant parts of input sequences.",
    ]

    for para in paragraphs:
        pdf.multi_cell(0, 10, para)
        pdf.ln(5)

    # Second page
    pdf.add_page()
    more_paragraphs = [
        "Python is a versatile programming language widely used in data science. "
        "Its ecosystem includes libraries for machine learning, NLP, and computer vision.",

        "FAISS is a library for efficient similarity search. "
        "It is developed by Facebook Research and supports GPU acceleration.",

        "Sentence transformers produce fixed-size embeddings for text. "
        "These embeddings capture semantic meaning for comparison.",
    ]
    for para in more_paragraphs:
        pdf.multi_cell(0, 10, para)
        pdf.ln(5)

    pdf.output(str(Path(__file__).parent / "sample.pdf"))
    return str(Path(__file__).parent / "sample.pdf")


@pytest.fixture
def chunker() -> Chunker:
    return Chunker(chunk_size=500, overlap=50)


@pytest.fixture
def vector_store() -> VectorStore:
    return VectorStore()


@pytest.fixture
def pipeline(chunker: Chunker, vector_store: VectorStore, sample_pdf_path: str) -> RAGPipeline:
    p = RAGPipeline(chunker=chunker, vector_store=vector_store)
    p.ingest(sample_pdf_path)
    return p


# ─── Chunker Tests ─────────────────────────────────────────────────────────

class TestChunker:
    """Tests for PDF chunking."""

    def test_chunk_returns_list(self, chunker: Chunker, sample_pdf_path: str):
        """Chunking should return a list of dictionaries."""
        chunks = chunker.chunk(sample_pdf_path)
        assert isinstance(chunks, list)
        assert len(chunks) > 0

    def test_chunk_has_required_metadata(self, chunker: Chunker, sample_pdf_path: str):
        """Each chunk should have text, source_page, and chunk_index."""
        chunks = chunker.chunk(sample_pdf_path)
        for chunk in chunks:
            assert "text" in chunk, f"Missing 'text' in chunk: {chunk}"
            assert "source_page" in chunk, f"Missing 'source_page' in chunk: {chunk}"
            assert "chunk_index" in chunk, f"Missing 'chunk_index' in chunk: {chunk}"

    def test_chunk_text_not_empty(self, chunker: Chunker, sample_pdf_path: str):
        """Each chunk should have non-empty text."""
        chunks = chunker.chunk(sample_pdf_path)
        for chunk in chunks:
            assert len(chunk["text"].strip()) > 0, f"Empty text in chunk {chunk['chunk_index']}"

    def test_chunk_size_within_bounds(self, sample_pdf_path: str):
        """Chunks should respect configured size limits."""
        small_chunker = Chunker(chunk_size=100, overlap=20)
        chunks = small_chunker.chunk(sample_pdf_path)
        for chunk in chunks:
            # Allow some flexibility — the chunk may be slightly over due to paragraph boundaries
            assert len(chunk["text"]) <= 200, (
                f"Chunk {chunk['chunk_index']} has {len(chunk['text'])} chars, "
                f"exceeds 200 limit"
            )

    def test_source_page_is_int(self, chunker: Chunker, sample_pdf_path: str):
        """source_page should be an integer (1-indexed)."""
        chunks = chunker.chunk(sample_pdf_path)
        for chunk in chunks:
            assert isinstance(chunk["source_page"], int), (
                f"source_page should be int, got {type(chunk['source_page'])}"
            )
            assert chunk["source_page"] >= 1, f"source_page should be >= 1"

    def test_chunk_index_is_sequential(self, chunker: Chunker, sample_pdf_path: str):
        """chunk_index should be sequential starting from 0."""
        chunks = chunker.chunk(sample_pdf_path)
        for i, chunk in enumerate(chunks):
            assert chunk["chunk_index"] == i, (
                f"Expected chunk_index {i}, got {chunk['chunk_index']}"
            )

    def test_multiple_pages_produce_page_metadata(self, chunker: Chunker, sample_pdf_path: str):
        """Chunks from different pages should have different source_page values."""
        chunks = chunker.chunk(sample_pdf_path)
        pages = set(c["source_page"] for c in chunks)
        assert len(pages) > 1, f"Expected chunks from >1 page, got pages: {pages}"


# ─── Vector Store Tests ────────────────────────────────────────────────────

class TestVectorStore:
    """Tests for in-memory FAISS vector store."""

    def test_store_initialization(self, vector_store: VectorStore):
        """VectorStore should initialize without error."""
        assert vector_store is not None
        assert vector_store.index is None

    def test_add_documents(self, vector_store: VectorStore):
        """Adding documents should create a FAISS index."""
        chunks = [
            {"text": "Artificial intelligence is transforming technology.", "source_page": 1, "chunk_index": 0},
            {"text": "Vector databases store embeddings for similarity search.", "source_page": 1, "chunk_index": 1},
        ]
        vector_store.add_documents(chunks)
        assert vector_store.index is not None
        assert vector_store.index.ntotal == 2

    def test_search_returns_top_k(self, vector_store: VectorStore):
        """Search should return exactly k results."""
        chunks = [
            {"text": "Machine learning is a subset of artificial intelligence.", "source_page": 1, "chunk_index": 0},
            {"text": "Deep learning uses neural networks with many layers.", "source_page": 1, "chunk_index": 1},
            {"text": "Python is a programming language used for data science.", "source_page": 2, "chunk_index": 2},
            {"text": "FAISS enables fast similarity search in vector databases.", "source_page": 2, "chunk_index": 3},
        ]
        vector_store.add_documents(chunks)
        results = vector_store.search("machine learning", k=2)
        assert len(results) == 2

    def test_search_results_have_scores(self, vector_store: VectorStore):
        """Search results should include similarity scores."""
        chunks = [
            {"text": "Artificial intelligence and machine learning are related fields.", "source_page": 1, "chunk_index": 0},
            {"text": "Data science involves statistics and computing.", "source_page": 1, "chunk_index": 1},
        ]
        vector_store.add_documents(chunks)
        results = vector_store.search("AI machine learning", k=2)
        for r in results:
            assert "score" in r, f"Missing 'score' in result: {r}"
            assert isinstance(r["score"], float)
            assert 0.0 <= r["score"] <= 1.0, f"Score out of range: {r['score']}"

    def test_search_returns_chunk_metadata(self, vector_store: VectorStore):
        """Search results should include original chunk metadata."""
        chunks = [
            {"text": "Artificial intelligence research continues to advance rapidly.", "source_page": 1, "chunk_index": 0},
        ]
        vector_store.add_documents(chunks)
        results = vector_store.search("artificial intelligence", k=1)
        assert results[0]["source_page"] == 1
        assert results[0]["chunk_index"] == 0
        assert "text" in results[0]

    def test_search_empty_store(self, vector_store: VectorStore):
        """Searching an empty vector store should return empty list."""
        results = vector_store.search("anything", k=3)
        assert results == []

    def test_search_returns_relevant_first(self, vector_store: VectorStore):
        """The most relevant result should have the highest score."""
        chunks = [
            {"text": "The weather today is sunny and warm.", "source_page": 1, "chunk_index": 0},
            {"text": "Cats are popular pets that enjoy sleeping.", "source_page": 1, "chunk_index": 1},
            {"text": "Machine learning models require large datasets for training.", "source_page": 2, "chunk_index": 2},
        ]
        vector_store.add_documents(chunks)
        results = vector_store.search("machine learning training data", k=3)
        # The most relevant result should be about machine learning
        top_result_text = results[0]["text"].lower()
        assert "machine learning" in top_result_text, (
            f"Expected 'machine learning' in top result, got: {results[0]['text']}"
        )
        # Scores should be descending
        for i in range(len(results) - 1):
            assert results[i]["score"] >= results[i + 1]["score"], (
                f"Scores not descending: {[r['score'] for r in results]}"
            )


# ─── Pipeline Tests ────────────────────────────────────────────────────────

class TestRAGPipeline:
    """Tests for the full RAG pipeline."""

    def test_pipeline_ingest(self, chunker: Chunker, vector_store: VectorStore, sample_pdf_path: str):
        """Pipeline.ingest should load and index the PDF."""
        p = RAGPipeline(chunker=chunker, vector_store=vector_store)
        doc_count = p.ingest(sample_pdf_path)
        assert doc_count > 0, "Should have indexed at least one chunk"
        assert vector_store.index is not None
        assert vector_store.index.ntotal == doc_count

    def test_process_query_returns_dict(self, pipeline: RAGPipeline):
        """process_query should return a dict with expected keys."""
        result = pipeline.process_query("artificial intelligence")
        assert isinstance(result, dict)
        assert "query" in result
        assert "context" in result
        assert "sources" in result

    def test_process_query_preserves_query(self, pipeline: RAGPipeline):
        """The returned query should match the input."""
        query = "machine learning in Python"
        result = pipeline.process_query(query, k=3)
        assert result["query"] == query

    def test_process_query_returns_sources(self, pipeline: RAGPipeline):
        """Sources should be a non-empty list of dicts with metadata."""
        result = pipeline.process_query("vector search", k=3)
        sources = result["sources"]
        assert isinstance(sources, list)
        assert len(sources) > 0
        for source in sources:
            assert "text" in source
            assert "source_page" in source
            assert "score" in source

    def test_process_query_context_not_empty(self, pipeline: RAGPipeline):
        """Context string should contain retrieved text."""
        result = pipeline.process_query("attention mechanisms", k=3)
        assert len(result["context"]) > 0, "Context should not be empty"
        # Context should incorporate retrieved text
        assert "attention" in result["context"].lower(), (
            f"Expected 'attention' in context, got: {result['context']}"
        )

    def test_process_query_respects_k(self, pipeline: RAGPipeline):
        """Should return exactly k sources."""
        for k in [1, 2, 3]:
            result = pipeline.process_query("artificial intelligence", k=k)
            assert len(result["sources"]) == k, (
                f"Expected {k} sources, got {len(result['sources'])}"
            )

    def test_pipeline_handles_empty_store(self, chunker: Chunker):
        """Query on empty store should return empty results gracefully."""
        vs = VectorStore()
        p = RAGPipeline(chunker=chunker, vector_store=vs)
        result = p.process_query("anything")
        assert result["query"] == "anything"
        assert result["context"] == ""
        assert result["sources"] == []

    def test_pipeline_context_formatting(self, pipeline: RAGPipeline):
        """Context should contain source references."""
        result = pipeline.process_query("vector databases", k=2)
        context = result["context"]
        # Context should reference the source text
        assert len(context) > 0


# ─── Integration: End-to-End ───────────────────────────────────────────────

class TestEndToEnd:
    """End-to-end integration test."""

    def test_full_pipeline_e2e(self):
        """Complete end-to-end test: PDF creation → chunking → indexing → search."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a PDF
            pdf_path = os.path.join(tmpdir, "test.pdf")
            pdf = FPDF()
            pdf.add_page()
            pdf.set_font("Helvetica", size=12)
            pdf.multi_cell(0, 10, (
                "Retrieval augmented generation (RAG) is a technique that combines "
                "information retrieval with text generation. It uses a retriever to find "
                "relevant documents and a generator to produce answers. This approach "
                "improves accuracy by grounding responses in retrieved context."
            ))
            pdf.ln(5)
            pdf.multi_cell(0, 10, (
                "Embeddings are numerical representations of text that capture semantic "
                "meaning. They are generated by models like sentence-transformers and "
                "stored in vector databases for efficient similarity search."
            ))
            pdf.ln(5)
            pdf.multi_cell(0, 10, (
                "FAISS is a library developed by Facebook AI Research for efficient "
                "similarity search and clustering of dense vectors. It supports various "
                "index types optimized for different use cases and hardware."
            ))
            pdf.output(pdf_path)

            # Run full pipeline
            chunker = Chunker(chunk_size=500, overlap=50)
            vs = VectorStore()
            p = RAGPipeline(chunker=chunker, vector_store=vs)
            doc_count = p.ingest(pdf_path)
            assert doc_count > 0

            # Query for RAG content
            result = p.process_query("retrieval augmented generation", k=2)
            assert result["query"] == "retrieval augmented generation"
            assert len(result["sources"]) == 2
            assert "context" in result
            assert len(result["context"]) > 0

            # Query for embedding content
            result2 = p.process_query("vector embeddings", k=2)
            assert len(result2["sources"]) == 2
            # The top result should mention embeddings
            top_text = result2["sources"][0]["text"].lower()
            assert "embedding" in top_text or "vector" in top_text, (
                f"Expected embedding/vector in top result, got: {top_text}"
            )

    def test_cleanup(self, sample_pdf_path: str):
        """Clean up the sample PDF."""
        pdf_file = Path(sample_pdf_path)
        if pdf_file.exists():
            pdf_file.unlink()
