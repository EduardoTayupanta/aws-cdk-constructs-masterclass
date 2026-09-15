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
| 2 | Lambda | 🔜 Next | Event-driven processing triggered from S3 |
| 3 | AWS Batch | ⏳ Planned | Heavier processing via a Python job, defined with CDK/TypeScript |
| 4 | Athena | ⏳ Planned | Querying pipeline output via Glue Data Catalog + Athena |

## Tech Stack

- **Infrastructure as Code:** AWS CDK, written in **TypeScript**.
- **Application/job code:** **Python** is used only where it naturally
  belongs — for example, inside the AWS Batch job's container image — never
  as an alternative CDK language.
- **Security & compliance checks:** [`cdk-nag`](https://github.com/cdklabs/cdk-nag)
  is applied to every stack in this repo, starting with the Step 1 scaffold.

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

## Documentation

- [`docs/01-cdk-constructs-and-levels.md`](docs/01-cdk-constructs-and-levels.md) —
  What constructs are and why AWS organizes them into L1, L2, and L3.
- [`docs/02-s3-foundations.md`](docs/02-s3-foundations.md) —
  Building the `DataLakeBucket` L2 construct and verifying it with cdk-nag.

More articles are added as each pipeline step is built.

## Getting Started

```bash
npm install
npm run build   # type-check the project
npm test        # run the Jest suite, including the cdk-nag check
npx cdk synth   # synthesize the CloudFormation template
```

## Repository Structure (evolving)

```
aws-cdk-constructs-masterclass/
├── bin/app.ts                          # CDK app entry point (registers cdk-nag)
├── lib/
│   ├── data-pipeline-stack.ts          # The single, growing pipeline stack
│   └── constructs/
│       └── data-lake-bucket.ts         # Step 1: the S3 L2 construct
├── test/                               # Jest + CDK assertions + cdk-nag checks
├── docs/                                # Written articles for the Community Builder series
└── README.md
```

## License

MIT
