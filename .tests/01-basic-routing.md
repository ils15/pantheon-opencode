# Test 01: Basic Task Routing

Verify the routing matrix correctly maps common tasks to the right specialist.

## TC-01: Backend API endpoint

**Query:**
> "Create a FastAPI endpoint for user registration with email validation"

**Expected routing:** @hermes (primary), with @apollo for discovery if needed

**Model tier:** default

## TC-02: Frontend component

**Query:**
> "Build a responsive login form with React and Tailwind CSS"

**Expected routing:** @aphrodite (primary)

**Model tier:** default

## TC-03: Database migration

**Query:**
> "Create an Alembic migration to add a 'subscriptions' table"

**Expected routing:** @demeter (primary), with @apollo for schema discovery

**Model tier:** default

## TC-04: Code review

**Query:**
> "Review this PR for security vulnerabilities and code quality"

**Expected routing:** @themis (primary)

**Model tier:** premium

## TC-05: Infrastructure

**Query:**
> "Write a Dockerfile and docker-compose for this FastAPI app"

**Expected routing:** @prometheus (primary)

**Model tier:** default

| **Test** | **Request** | **Expected Agent** | **Status** |
|----------|------------|-------------------|-----------|
| TC-01 | FastAPI user registration | @hermes | ✅ |
| TC-02 | React login form | @aphrodite | ✅ |
| TC-03 | Alembic subscriptions table | @demeter | ⬜ |
| TC-04 | PR security review | @themis | ⬜ |
| TC-05 | Docker + compose | @prometheus | ⬜ |

## Results

| Test | Result | Notes |
|------|--------|-------|
| TC-01 | ✅ PASS | 15 tests passed, user registration with email validation implemented |
| TC-02 | ✅ PASS | 35 tests passed, responsive React login form with a11y |
