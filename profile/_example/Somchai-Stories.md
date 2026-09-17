# Somchai-Stories.md — STAR Evidence (FILLED EXAMPLE — fictional)

> Example stories file — the honesty checker's cross-reference. One story per major resume claim.

---

## Story 1: "Cut deployment time 95% (1 day → 3–5 min)"

**Situation:** Legacy WMS deployed manually — a full-day process with a freeze window, run monthly.
**Task:** As reporting-module owner, I was asked to containerize my module and set up a pipeline the team could reuse.
**Action:** Wrote the Dockerfile for the reporting service, built a Jenkins pipeline (build → test → image → deploy to staging), documented it, and migrated 10+ DB2 stored procedures to Spring Boot ORM so the module could deploy independently.
**Result:** Module deploys dropped from the shared 1-day window to 3–5 minutes; two other backend modules adopted the same pipeline.
**Evidence:** Jenkins build history (timestamps), team retrospective notes.
**Likely follow-ups:** "What broke during rollout?" (DB connection pooling config in containers), "Why Jenkins not GitLab CI?" (company standard).

## Story 2: "Test coverage 0% → 90%"

**Situation:** The legacy reporting module had zero automated tests; every change was manual regression.
**Task:** Establish a test suite before migration so behavior could be verified.
**Action:** Wrote characterization tests around stored-proc outputs first (golden data), then JUnit + Testcontainers suites for the Spring Boot replacement; enforced 80% minimum in the pipeline, reached 90%.
**Result:** Migration shipped with zero production data-integrity incidents; coverage stayed ≥90%.
**Evidence:** Jenkins coverage reports, SonarQube history.
**Likely follow-ups:** "How did you test stored procedures?" (golden-output comparison on seeded DB2 copies).

## Story 3: "Report API ~30% faster with Redis"

**Situation:** Daily sales reports took 4–6s; store ops complained during peak.
**Task:** Reduce latency without schema changes (report deadline).
**Action:** Profiled slow queries (EXPLAIN), added Redis caching for the 5 hottest aggregation endpoints with 10-min TTL, kept DB fallback.
**Result:** p95 latency down ~30% (Grafana); no correctness complaints after launch.
**Evidence:** Grafana dashboards before/after.
**Likely follow-ups:** "Cache invalidation strategy?" (TTL + explicit purge on nightly ETL completion).

---

## Story Index

| Resume claim | Story # | Verified how |
|---|---|---|
| Deploy time −95% | 1 | Jenkins logs |
| Coverage 0→90% | 2 | CI coverage reports |
| API ~30% faster | 3 | Grafana |
| 8K daily queries @99% | — | Access logs + monitoring (story not written — small claim) |
