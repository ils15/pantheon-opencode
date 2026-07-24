"""PDF chunker — reads PDF files and splits into chunks with metadata.

Uses PyMuPDF (fitz) for PDF parsing and supports configurable chunk sizes
with paragraph-aware splitting and overlap.
"""

import re
from typing import Any

import fitz


class Chunker:
    """Splits PDF documents into text chunks with metadata.

    Args:
        chunk_size: Maximum characters per chunk (500-1000).
        overlap: Number of overlapping characters between chunks (50-200).

    Example:
        >>> chunker = Chunker(chunk_size=500, overlap=50)
        >>> chunks = chunker.chunk("document.pdf")
        >>> chunks[0]
        {'text': '...', 'source_page': 1, 'chunk_index': 0}
    """

    def __init__(self, chunk_size: int = 500, overlap: int = 50) -> None:
        self.chunk_size = max(100, min(chunk_size, 1000))
        self.overlap = max(0, min(overlap, 200, self.chunk_size // 2))

    def chunk(self, pdf_path: str) -> list[dict[str, Any]]:
        """Read a PDF and split into chunks with metadata.

        Args:
            pdf_path: Path to the PDF file.

        Returns:
            List of chunk dicts with keys: text, source_page, chunk_index.
        """
        doc = fitz.open(pdf_path)
        all_paragraphs: list[tuple[str, int]] = []

        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text()
            page_paragraphs = self._extract_paragraphs(text)
            for para in page_paragraphs:
                stripped = para.strip()
                if stripped:
                    all_paragraphs.append((stripped, page_num + 1))

        doc.close()
        return self._build_chunks(all_paragraphs)

    def _extract_paragraphs(self, text: str) -> list[str]:
        """Extract paragraphs from page text.

        Handles PDFs where paragraph boundaries may be:
        1. Double newlines (\\n\\n) — clean text
        2. Single newlines with indent/length heuristics — fpdf2 output
        """
        raw = text.replace("\r\n", "\n").replace("\r", "\n")

        # Strategy 1: Split on double newlines
        candidates = [p.strip() for p in raw.split("\n\n") if p.strip()]
        candidates = [" ".join(c.split()) for c in candidates]

        # Strategy 2: If no double-newline splits, try single newlines
        if len(candidates) <= 1:
            lines = raw.split("\n")
            candidates = self._merge_lines_to_paragraphs(lines)

        # Strategy 3: If still just one block, try sentence-aware splitting
        if len(candidates) <= 1 and candidates:
            sentences = re.split(r"(?<=[.!?])\s+", candidates[0])
            if len(sentences) > 1:
                # Group 2-3 sentences per paragraph as a reasonable heuristic
                candidates = self._group_sentences(sentences)

        return candidates

    @staticmethod
    def _merge_lines_to_paragraphs(lines: list[str]) -> list[str]:
        """Merge lines into paragraphs using heuristics."""
        paragraphs: list[str] = []
        current: list[str] = []

        for line in lines:
            stripped = line.strip()
            if not stripped:
                if current:
                    paragraphs.append(" ".join(current))
                    current = []
                continue

            # Start a new paragraph if the line starts with a capital letter
            # and the current paragraph is already substantial
            if current and stripped[0].isupper() and len(" ".join(current)) > 100:
                paragraphs.append(" ".join(current))
                current = [stripped]
            else:
                current.append(stripped)

        if current:
            paragraphs.append(" ".join(current))

        return paragraphs

    @staticmethod
    def _group_sentences(sentences: list[str]) -> list[str]:
        """Group sentences into paragraphs (~3 sentences each)."""
        groups: list[str] = []
        for i in range(0, len(sentences), 3):
            group = " ".join(sentences[i : i + 3])
            if group.strip():
                groups.append(group.strip())
        return groups

    def _split_paragraph(
        self, text: str, page: int
    ) -> list[tuple[str, int]]:
        """Split a single paragraph that exceeds chunk_size into smaller pieces.

        Splits at sentence boundaries to maintain coherence.
        """
        if len(text) <= self.chunk_size:
            return [(text, page)]

        # Split into sentences
        sentences = re.split(r"(?<=[.!?])\s+", text)
        pieces: list[str] = []
        current = ""

        for sentence in sentences:
            candidate = (current + " " + sentence).strip() if current else sentence
            if len(candidate) <= self.chunk_size or not current:
                current = candidate
            else:
                if current:
                    pieces.append(current)
                current = sentence

        if current:
            pieces.append(current)

        # If sentence splitting didn't help (e.g., one very long sentence),
        # split by character count at word boundaries
        result: list[tuple[str, int]] = []
        for piece in pieces:
            if len(piece) <= self.chunk_size:
                result.append((piece, page))
            else:
                result.extend(self._split_by_chars(piece, page))

        return result

    def _split_by_chars(
        self, text: str, page: int
    ) -> list[tuple[str, int]]:
        """Split text by character count at word boundaries."""
        pieces: list[tuple[str, int]] = []
        start = 0
        while start < len(text):
            end = min(start + self.chunk_size, len(text))
            if end < len(text):
                # Find word boundary
                space_idx = text.rfind(" ", start + self.chunk_size // 2, end)
                if space_idx > 0:
                    end = space_idx
            pieces.append((text[start:end].strip(), page))
            start = end
        return pieces

    def _build_chunks(
        self, paragraphs: list[tuple[str, int]]
    ) -> list[dict[str, Any]]:
        """Build chunks from paragraphs, respecting chunk_size and overlap."""
        chunks: list[dict[str, Any]] = []
        chunk_index = 0
        buffer = ""
        buffer_start_page = 1

        i = 0
        while i < len(paragraphs):
            text, page = paragraphs[i]

            if not buffer:
                buffer_start_page = page

            # If the single paragraph exceeds chunk_size, split it first
            if len(text) > self.chunk_size:
                # Flush current buffer first
                if buffer:
                    chunks.append({
                        "text": buffer,
                        "source_page": buffer_start_page,
                        "chunk_index": chunk_index,
                    })
                    chunk_index += 1
                    buffer = ""
                    buffer_start_page = page

                # Add overlap from previous chunk if needed
                if self.overlap > 0 and chunks:
                    prev_chunk = chunks[-1]["text"]
                    overlap_text = self._get_overlap(prev_chunk)
                    if overlap_text:
                        text = overlap_text + " " + text

                # Split the long paragraph
                sub_pieces = self._split_paragraph(text, page)
                for sub_text, sub_page in sub_pieces:
                    chunks.append({
                        "text": sub_text,
                        "source_page": sub_page,
                        "chunk_index": chunk_index,
                    })
                    chunk_index += 1
                i += 1
                continue

            # Check if adding this paragraph would exceed chunk_size
            candidate = (buffer + "\n\n" + text).strip() if buffer else text
            if len(candidate) <= self.chunk_size:
                buffer = candidate
            else:
                # Flush current buffer as a chunk
                chunks.append({
                    "text": buffer,
                    "source_page": buffer_start_page,
                    "chunk_index": chunk_index,
                })
                chunk_index += 1

                # Start new buffer with overlap
                if self.overlap > 0 and buffer:
                    overlap_text = self._get_overlap(buffer)
                    buffer = (overlap_text + "\n\n" + text).strip() if overlap_text else text
                else:
                    buffer = text
                buffer_start_page = page

            i += 1

        # Final chunk
        if buffer:
            chunks.append({
                "text": buffer,
                "source_page": buffer_start_page,
                "chunk_index": chunk_index,
            })

        return chunks

    def _get_overlap(self, text: str) -> str:
        """Extract the last `overlap` characters from text for overlap."""
        if self.overlap <= 0 or len(text) <= self.overlap:
            return ""
        overlap_start = len(text) - self.overlap
        return text[overlap_start:].lstrip()
