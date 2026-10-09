# OpenFGA in practice: what users and engineering blogs report

Researched on 9 October 2026. Every source below was opened and read unless marked otherwise.
Related: [tech-design.md](tech-design.md), [list-queries-comparison.md](list-queries-comparison.md).

## What the evidence says

Public experience reports agree on three things, and they match what the POC found.

- **Single checks work well at scale.** Teams report millisecond checks at thousands of requests per
  second and billions of tuples.
- **Two problems come up again and again:** listing and searching with permissions, and keeping
  OpenFGA's data in step with the application database.
- **Teams that are one application on one database sometimes decide against it,** or leave it, and
  do the same job in Postgres.

Nothing found contradicts the direction already recommended for this project: central OpenFGA for the
organisation tree and per-item checks, with list screens filtered in each application's own database.

## How much to trust each kind of source

| Kind | Examples below | Bias to keep in mind |
| --- | --- | --- |
| First-hand engineering posts | Openlane, Rover, Infisical | Most useful. One team's context each |
| Adopter case studies published by OpenFGA | Read AI, Grafana, Docker, Headspace, Vitrolife | Real companies and numbers, but selected and written up by the project; little about problems |
| Issue trackers | OpenFGA #2828, Thales fred #2845 | Factual and specific, narrow |
| Independent practitioner blogs | Montelli, Steele | Individuals; figures are informal |
| Vendors and competitors | Auth0, Permit.io, Oso and AuthZed staff on Hacker News | Each has a product to sell; useful for the arguments, not as neutral verdicts |

No relevant Reddit threads turned up. Hacker News discussion of OpenFGA is thin: the largest thread
found had 13 comments.

## Positive experience: checks at scale

All of these come from OpenFGA's own [adopters page](https://openfga.dev/docs/adopters), which says
it is based on CNCF adopter interviews and community meeting talks.

| Company | Use | Reported figures | Notable point |
| --- | --- | --- | --- |
| [Read AI](https://openfga.dev/docs/adopters/read-ai) | Sharing across meetings, messages, email, documents | 5,200 requests per second at peak, 20 ms p99, 1.8 ms average, 5.3 billion tuples, in production since April 2023 | "OpenFGA has not been the bottleneck even at peak." Chose it over AuthZed for documentation, self-hosting cost and maintainer responsiveness |
| [Headspace](https://openfga.dev/docs/adopters/headspace) | Gating access to an AI companion by contract, country, language and employer opt-out | 10 to 15 ms per authorization | The first model took 10 to 15 seconds in the worst case. Redesigning the model, not tuning the server, fixed it |
| [Grafana Labs](https://openfga.dev/docs/adopters/grafana) | Replacing an in-house engine across cloud, open source and on-premises | No throughput figures; external production still shadowing traffic | Standardised on Postgres after finding the MySQL adapter less mature |
| Docker | Centralising authorization across products | 100 to 150 requests per second, since March 2024 | Permission changes moved from code to the model file |
| Agicap | All backend services, 8,000+ customers | About 250 requests per second | Schema changes replaced code changes for new permissions |
| [Vitrolife](https://openfga.dev/docs/adopters/vitrolife) | Internal platform at a medical-device company | None given | Hybrid with Microsoft Entra, described below |

Reasons adopters gave for choosing it: it can be self-hosted, relationship-based rules fit better
than flat roles, and CNCF governance lowers licensing risk. OpenFGA became a CNCF incubating project
in November 2025.

**Lesson for this project:** Headspace's thousandfold improvement came from how the model was
shaped. Model design deserves review and load testing before rollout, not after.

## Problem 1: lists, search and reports

This is the most consistently reported difficulty, and the same one in
[list-queries-comparison.md](list-queries-comparison.md).

- **[Openlane](https://www.theopenlane.io/blog/from-10-seconds-to-400ms-optimizing-graphql-and-infrastructure-at-openlane/)**
  (Sarah Funkhouser, Head of Engineering, April 2025). A complex query took 8 to 10 seconds. The
  post names ListObjects as a cause: it "does not support pagination" and "is not optimized for
  filtering large object sets". They switched to querying their own database and filtering with
  BatchCheck, which they say beat ListObjects "by miles". The cost: "your totalCount will be wrong",
  because rows are removed after the database has counted them. The post gives no fix for that.
- **[Thales, fred issue 2845](https://github.com/ThalesGroup/fred/issues/2845)** (September 2026,
  marked critical, open). ListObjects returned exactly 1,000 of 5,045 readable documents, with no
  error. Folders with documents showed as empty, and deleting a folder left its documents orphaned.
- **[OpenFGA issue 2828](https://github.com/openfga/openfga/issues/2828)** (November 2025, open, no
  maintainer reply visible). Asks for paging on ListObjects. It states that when the 3 second
  deadline is hit, partial results come back with no sign they are incomplete, and the same query
  can return different counts under load.
- **[Francesco Montelli](https://montelli.dev/en/blog/verificare/openfga/05-listobjects-performance/)**
  (independent engineer, May 2026). Reports ListObjects at 5 to 15 ms for a few hundred documents and
  200 to 500 ms for 50,000 documents in a four-level hierarchy. The method is not described, so
  treat these as rough. His view: "This is not a flaw in OpenFGA: it is the nature of the problem
  being solved." He recommends combining a SQL fast path, short-lived caching, and BatchCheck, with
  a stored read-model table as the last resort.
- **[Hacker News thread](https://news.ycombinator.com/item?id=45661547)** (October 2025). One
  commenter asks how to get "a paginated list of authorized results" from a separate authorization
  service. The CTO of AuthZed, a competing Zanzibar-style product, replies that it is "actually
  quite a challenging problem".
- **[Auth0 engineering](https://auth0.com/blog/openfga-improved-listobjects-algorithm/)** (February
  2026). The maintainers rebuilt ListObjects as a streaming pipeline. The post gives no benchmark
  figures and does not mention paging, so it improves speed without removing the limits above. The
  v1.22.0 server in the POC logged this pipeline as enabled.

**Lessons for this project**

- Never treat a ListObjects result as complete. Either list units, which stay far below 1,000, or
  detect a result at the cap and fail loudly.
- The "wrong total count" problem Openlane hit is the weakness of the batch-check strategy.
  Filtering by unit in SQL avoids it.
- Do not drive deletes or other destructive actions from a ListObjects result.

## Problem 2: keeping OpenFGA in step with your data

- **[Rover](https://getrover.substack.com/p/how-we-rewrote-openfga-in-pure-postgres)** (Isaac
  Harris-Holt, March 2025). A multi-tenant SaaS that left OpenFGA and reimplemented the parts it
  used inside Postgres. "The big problem that we kept running into was keeping everything in sync
  all the time." Specific pains: no shared transaction between database writes and tuple writes,
  cascading deletes for data-protection requests, manual database edits that never reached OpenFGA,
  and a change-capture pipeline judged too complex to run. They admit their version drops features
  they did not need, and may need materialising later for performance.
- **[Permit.io recap of a KubeCon 2024 maintainer panel](https://permit.io/blog/policy-engine-showdown-opa-vs-openfga-vs-cedar)**
  (January 2025, vendor). Names getting data into OpenFGA as its hard part, needing event-driven
  updates or change streams.
- **[Vitrolife](https://openfga.dev/docs/adopters/vitrolife)**. Shows the pattern that works: a
  transactional outbox commits the database row and the queued tuple change together, with an
  hourly full reconciliation as a safety net. They accept a short delay before changes are visible.
- **[Joshua Steele](https://joshuapsteele.com/real-world-openfga-authorization-lessons/)** (May
  2025). Asks publicly how teams load tuples and avoid stale ones, and notes that the documentation
  "tend[s] to focus on small-scale setups" and real case studies are hard to find. The post had no
  replies when read.

**Lessons for this project**

- Rover is the scenario of one application on one database, where the earlier advice here was also
  to build custom. With five or more applications sharing one organisation tree, that route is not
  available in the same way.
- Budget for the sync layer as real work: an outbox per application that writes tuples, plus a
  scheduled reconciliation job. The POC writes tuples directly and has neither.
- Limit who writes what. If only the HR system writes the organisation tree, most of the sync
  problem sits in one place.

## Teams that decided against a Zanzibar-style system

- **[Infisical](https://infisical.com/blog/folder-based-rbac)** (September 2026). Built folder-based
  permissions in their existing database. Their reasons: adopting OpenFGA or SpiceDB meant
  "rewriting every permission check" and making self-hosted customers "run another stateful
  service". In the [discussion](https://news.ycombinator.com/item?id=49635043), an AuthZed
  co-founder countered that home-grown systems rarely get proper debugging and correctness tooling.
- **Oso staff on Hacker News** call the sync burden "a fundamental problem with all Zanzibar-inspired
  authorization systems" and promote keeping some authorization data local. Oso sells a competing
  product, and another commenter said Oso has since pivoted to AI, which I did not verify.

Both cases are single products weighing a migration, not an organisation designing shared access
control for many new applications.

## Other operational notes

- **Model changes need a process.** Rover found the CLI could not confirm that the stored model
  matched the schema file, so they re-applied it on every deploy. Headspace manages the model with
  Terraform and hides the model version behind a wrapper service so callers never coordinate upgrades.
- **Wrap OpenFGA behind your own thin service or library.** Headspace and Vitrolife both do this,
  for typed identifiers, consistent error handling and model versioning.
- **Use Postgres.** Every production adopter listed runs on it, and Grafana moved off the MySQL adapter.
- **Caching trades freshness for speed.** The [production guide](https://openfga.dev/docs/best-practices/running-in-production)
  recommends enabling check caching and warns responses become staler.
- **Tail latency is actively worked on.** [Auth0 reports](https://auth0.com/blog/self-tuning-strategy-planner-openfga/)
  a planner that cut p99 check latency. I read only the search summary of this post, which quoted a
  98% reduction.

## What this means for the decision

| Earlier conclusion | Does the research support it? |
| --- | --- |
| Checks on single items are OpenFGA's strength | Yes: Read AI, Headspace, Docker, Agicap |
| Lists and reports are its weak point | Yes, strongly: Openlane, Thales, issue 2828, Montelli |
| For one application on one database, custom is reasonable | Yes: Rover and Infisical did exactly that |
| For many applications sharing one tree, centralise | Partly: Docker and Grafana centralised for this reason, but no source describes a mix as broad as HR, payroll, workflow, health and network devices |
| List screens should filter by unit in the application's database | Consistent with what Openlane and Montelli ended up doing, though neither uses a unit tree |

### Additions to the plan that the research suggests

1. Build the sync layer deliberately: outbox plus reconciliation.
2. Put a thin shared wrapper in front of OpenFGA for all applications.
3. Treat any ListObjects result of 1,000 as truncated.
4. Load-test the model with realistic data before the second application joins.
5. Put the model under version control with an automated check that the deployed model matches.

## Gaps in this research

- No first-hand account was found of OpenFGA for HR or payroll, or for network device management.
  OpenFGA publishes sample models for both, but a sample is not a production report.
- A Medium post on two years of OpenFGA in a multi-tenant SaaS could not be opened (access denied).
  A search summary said it describes a parent-to-child inheritance rule that gave an organisation
  admin unintended edit rights, and the lack of tooling for migrating tuples when a relation is
  renamed. Unverified.
- A 9fin post, "From Postgres RLS to OpenFGA: Lessons from building (and replacing) our
  authorisation system" (May 2026), looks directly relevant, but only its title and byline loaded.
  [Worth reading by hand.](https://9fin.com/insights/postgres-rls-openfga-authorisation-system)
- Adopter figures are undated on the page and self-reported.
