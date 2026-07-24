# Sample API for Testing Pantheon v4.0

This is an intentionally imperfect FastAPI project designed for testing Pantheon commands and skills.

## Purpose

This project contains deliberate code smells, anti-patterns, and missing features so that Pantheon tools have something to work on:

- **`/praxis`** → Add missing `/health` endpoint via plan execution
- **`/metamorphosis`** → Refactor the service layer (N+1 queries, sync→async, type hints)
- **`auto-continue`** → Auto-continue through TDD test-writing cycle
- **`auto-continue`** → Auto-continue through all remaining tasks
- **`ai-slop-remover`** → Clean up verbose AI-generated comments in services
- **`review-work`** → Comprehensive review of all code quality issues
- **`wisdom-accumulation`** → Pass learnings between refactoring waves

## Known Issues (by design)

- No `/health` endpoint
- Sync SQLAlchemy instead of async
- N+1 query patterns in services
- Heavy AI slop comments (verbose, redundant)
- Missing type hints
- Direct model imports in routes (anti-pattern)
- Inline DB queries instead of service layer
- No tests
- Suboptimal Dockerfile (runs as root, no health check)
- No `.dockerignore`

## Quick Start

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

## Testing Pantheon Commands

1. Run `/praxis` to add the `/health` endpoint
2. Run `/metamorphosis` to refactor the service layer
3. Run `ai-slop-remover` to clean up comments
4. Run `review-work` for comprehensive code review
5. Use `auto-continue` to complete all tasks
