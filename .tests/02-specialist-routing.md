# Test 02: Specialist Agent Routing

Verify routing for specialized domains (AI, geospatial, conversational, etc.).

## TC-06: RAG pipeline

**Query:**
> "Build a RAG pipeline that chunks PDFs and retrieves via vector search"

**Expected routing:** @hephaestus (primary)

**Model tier:** default

## TC-09: Satellite imagery

**Query:**
> "Classify land use from Sentinel-2 imagery with NDVI analysis"

**Expected routing:** @gaia (primary)

**Model tier:** default

## TC-10: Observability

**Query:**
> "Set up OpenTelemetry tracing and cost tracking for our AI agents"

**Expected routing:** @nyx (primary)

**Model tier:** fast

## TC-11: Hotfix

**Query:**
> "Fix this CSS typo: color: 'whiite' → color: 'white'"

**Expected routing:** @talos (primary, bypasses orchestration)

**Model tier:** fast

| **Test** | **Request** | **Expected Agent** | **Status** |
|----------|------------|-------------------|-----------|
| TC-06 | RAG pipeline | @hephaestus | ⬜ |
| TC-09 | Satellite LULC | @gaia | ⬜ |
| TC-10 | OpenTelemetry tracing | @nyx | ⬜ |
| TC-11 | CSS hotfix | @talos | ⬜ |
