# Test 03: Multi-Agent Orchestration

Verify complex tasks that require multiple agents working together.

## TC-13: Full feature — User authentication (4 agents)

**Query:**
> "Implement user authentication: create the DB schema, backend endpoints, and frontend login form"

**Expected routing:**
1. @athena — plan (premium)
2. @demeter — schema migration
3. @hermes — backend endpoints
4. @aphrodite — frontend form
   (Parallel: @demeter + @hermes + @aphrodite)
5. @themis — review (premium)

**Model tier:** mixed (premium + default)

## TC-15: Deploy full stack (3 agents)

**Query:**
> "Dockerize the app, set up CI/CD, and deploy to staging"

**Expected routing:**
1. @prometheus — Docker + CI/CD
2. @themis — review config (premium)
3. @iris — GitHub release

**Model tier:** default + premium + fast

## TC-16: Architecture decision

**Query:**
> "Should we use PostgreSQL or MongoDB for our time-series data?"

**Expected routing:** @zeus (council dispatch)

**Model tier:** premium

## TC-17: Strategic planning

**Query:**
> "Plan the architecture for a multi-tenant SaaS platform"

**Expected routing:** @athena (strategic planning), with @apollo for research

**Model tier:** premium

| **Test** | **Request** | **Expected Agents** | **Status** |
|----------|------------|--------------------|-----------|
| TC-13 | User auth (full stack) | athena → demeter + hermes + aphrodite → themis | ⬜ |
| TC-15 | Deploy full stack | prometheus → themis → iris | ⬜ |
| TC-16 | DB architecture choice | @zeus (council dispatch) | ⬜ |
| TC-17 | SaaS architecture plan | @athena + @apollo | ⬜ |
