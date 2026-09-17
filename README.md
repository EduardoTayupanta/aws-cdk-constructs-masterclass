# AWS CDK Constructs Masterclass

A hands-on, **living** deep dive into AWS CDK constructs — what they are,
why they come in levels (L1 / L2 / L3), and how to use them to build a real
architecture incrementally, one construct at a time.

This repository is written to accompany a documentation series for the
[AWS Community Builders](https://aws.amazon.com/developer/community/community-builders/)
program. Content is added step by step rather than all at once, so the
`main` branch reflects the current state of the series, not a finished demo.

## Why This Repo Exists

Most CDK tutorials show a single isolated example. This project instead
builds **one small, real data pipeline incrementally**, adding a new AWS
service — and a new construct-level concept — at each step:

```
S3  →  Lambda  →  AWS Batch (Python)  →  Athena
```

| Step | Service | Status | Focus |
|------|---------|--------|-------|
| 0 | — | ✅ Done | [Understanding Constructs & Why They Have Levels](docs/01-cdk-constructs-and-levels.md) |
| 1 | S3 | ✅ Done | [Foundational L2 usage, verified with cdk-nag](docs/02-s3-foundations.md) |
| 2 | Lambda | ✅ Done | [Reacting to S3 events; cdk-nag's first real trade-offs](docs/03-lambda-ingest.md) |
| 3 | AWS Batch | ✅ Done | [Fargate, VPC endpoints, and why EventBridge's Batch target isn't enough alone](docs/04-batch-processing.md) |
| 4 | Athena | ✅ Done | [Glue Data Catalog + Athena over processed/, with no L2 to reach for](docs/05-athena-glue.md) |

## Tech Stack

- **Infrastructure as Code:** AWS CDK, written in **TypeScript**.
- **Application/job code:** **Python** is used only where it naturally
  belongs — for example, inside the AWS Batch job's container image — never
  as an alternative CDK language.
- **Security & compliance checks:** [`cdk-nag`](https://github.com/cdklabs/cdk-nag)
  is applied to every stack in this repo, starting with the Step 1 scaffold.
- **Docker:** required to actually deploy (`cdk deploy`) from Step 2
  onward, since `IngestFunction` and the Step 3 Batch job (`batch/process/`)
  are both packaged as container images — but *not* for `npm run build`,
  `npm test`, or `cdk synth`. A Docker-compatible builder such as Finch or
  Podman also works, via `CDK_DOCKER`. See
  [docs/03-lambda-ingest.md](docs/03-lambda-ingest.md) for the details.

## Security & Compliance: cdk-nag

Every stack in this repo is validated with **cdk-nag** — a set of rule
packs (this project uses [AWS Solutions](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md))
that check the construct tree for violations such as unencrypted buckets,
overly permissive IAM policies, or missing access logging *before* the
stack is ever deployed.

It's registered once, at the `App` level in [`bin/app.ts`](bin/app.ts), via
CDK's native `Validations` API (the cdk-nag 3.x way — see
[the Step 1 article](docs/02-s3-foundations.md#the-api-changed-under-our-feet-cdk-nag-3x)
for what changed from the older `Aspects`-based pattern):

```ts
import { Validations } from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
```

Any violation that is a deliberate, documented trade-off (rather than an
oversight) is acknowledged explicitly with `Validations.of(construct).acknowledge({ id, reason })`
and a comment explaining *why* — suppressions are never silent. Each
pipeline step's article calls out any suppressions it introduces (Step 1
ships with none — see the article for why).

## Construct ID Conventions

This project is one single, growing `DataPipelineStack` — every step adds
more constructs to the *same* tree, so ID collisions become more likely
over time than in a repo full of small, disposable stacks. The rules below
apply to every construct added from Step 1 onward, and are based on the
[AWS CDK Design Guidelines](https://github.com/aws/aws-cdk/blob/main/docs/DESIGN_GUIDELINES.md#construct-ids):

1. **IDs only need to be unique among siblings, not across the whole
   stack.** CDK enforces this automatically — defining two children with
   the same ID under the same scope fails at synth time. The rules below
   are about human readability and long-term stability, not about working
   around a limitation CDK doesn't actually have.
2. **PascalCase, and name the construct's *role*, not its AWS type.**
   Prefer `RawDataBucket` over `Bucket1` or `S3Bucket`. A role-based name
   is very unlikely to collide with the next step's constructs, since each
   pipeline stage does a different job.
3. **Don't stutter the parent's name into the child's ID.** Inside
   `RawDataBucket` (a `DataLakeBucket`), children are `Bucket` and
   `AccessLogsBucket` — not `RawDataBucketBucket`. The full, unique
   identity already comes from the construct *path* (`RawDataBucket/Bucket`),
   not from repeating context in every segment.
4. **Use the ID `Resource` for a construct's single primary wrapped
   resource** — this is CDK's own internal convention (it's why
   `.node.defaultChild` works predictably on built-in L2s). It only
   applies when a construct wraps exactly *one* resource 1:1. `DataLakeBucket`
   deliberately does **not** use it: it owns two co-equal buckets, so both
   get an explicit, descriptive ID instead.
5. **Never concatenate strings to force uniqueness in a loop.** If a
   future step needs several similar resources (e.g. multiple Batch job
   definitions), create an intermediate `Construct` to act as a namespace,
   per the CDK guideline's own example, rather than building IDs like
   `Job-${name}`.
6. **Treat existing IDs as stable once shipped.** A construct ID feeds
   into the generated CloudFormation logical ID; renaming one after a real
   deployment replaces the underlying resource. Get the name right before
   merging, not after.

**Top-level IDs already used in `DataPipelineStack`** (each pipeline step
appends to this list so the next one can pick a non-colliding, on-theme
name at a glance):

| ID | Step | Construct |
|----|------|-----------|
| `RawDataBucket` | 1 (S3) | `DataLakeBucket` |
| `IngestFunction` | 2 (Lambda) | `IngestFunction` |
| `ProcessingJob` | 3 (AWS Batch) | `ProcessingJob` |
| `ProcessingTrigger` | 3 (AWS Batch) | `ProcessingTrigger` |
| `QueryCatalog` | 4 (Athena) | `QueryCatalog` |

## Documentation

- [`docs/01-cdk-constructs-and-levels.md`](docs/01-cdk-constructs-and-levels.md) —
  What constructs are and why AWS organizes them into L1, L2, and L3.
- [`docs/02-s3-foundations.md`](docs/02-s3-foundations.md) —
  Building the `DataLakeBucket` L2 construct and verifying it with cdk-nag.
- [`docs/03-lambda-ingest.md`](docs/03-lambda-ingest.md) —
  Wiring Lambda to S3 events and cdk-nag's first genuinely justified
  suppressions.
- [`docs/04-batch-processing.md`](docs/04-batch-processing.md) —
  AWS Batch on Fargate, VPC endpoints instead of a NAT Gateway, and why
  EventBridge's native Batch target can't carry a triggering object's key.
- [`docs/05-athena-glue.md`](docs/05-athena-glue.md) —
  Glue Data Catalog + Athena over `processed/`, hand-composing L1s where
  `aws-cdk-lib` has no L2, and why there's deliberately no Glue Crawler.

More articles are added as each pipeline step is built.

## Getting Started

```bash
npm install
npm --prefix lambda/ingest install   # the ingest Lambda's own, independent sub-project
npm run build   # type-check the project (CDK app + the ingest Lambda's own sub-project)
npm test        # run the Jest suite, including the cdk-nag check
npx cdk synth   # synthesize the CloudFormation template — no Docker needed
npx cdk deploy  # actually deploy — this is the step that needs Docker
npx cdk destroy # tear down this stack's resources
npx cdk gc      # also reclaim assets (e.g. the container images) no stack references anymore
```

## Repository Structure (evolving)

```
aws-cdk-constructs-masterclass/
├── bin/app.ts                          # CDK app entry point (registers cdk-nag)
├── lib/
│   ├── data-pipeline-stack.ts          # The single, growing pipeline stack
│   └── constructs/
│       ├── data-lake-bucket.ts         # Step 1: the S3 L2 construct
│       ├── ingest-function.ts          # Step 2: the Lambda L2 construct
│       ├── processing-job.ts           # Step 3: VPC + Batch (Fargate) L2 composition
│       ├── processing-trigger.ts       # Step 3: the Zip Lambda that submits Batch jobs
│       └── query-catalog.ts            # Step 4: Glue Database/Table + Athena WorkGroup (L1s, no L2 exists)
├── lambda/
│   ├── ingest/                          # Step 2: self-contained container-image Lambda
│   │   ├── index.ts                     #   handler code
│   │   ├── Dockerfile                   #   two-stage build: esbuild, then AWS's Lambda base image
│   │   └── package.json                 #   its own deps, independent of the CDK app's
│   └── processing-trigger/              # Step 3: Zip Lambda, bundled by the CDK app itself
│       └── index.ts                     #   handler code (no separate sub-project needed)
├── batch/
│   └── process/                         # Step 3: self-contained container-image Batch job
│       ├── process.py                   #   raw/ -> processed/ (JSON Lines) transform
│       ├── Dockerfile                   #   plain Python base image
│       └── requirements.txt             #   its own deps (boto3)
├── test/                               # Jest + CDK assertions + cdk-nag checks
├── docs/                                # Written articles for the Community Builder series
└── README.md
```

## License

MIT
