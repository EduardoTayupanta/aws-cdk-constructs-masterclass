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
| 1 | S3 | 🔜 Next | Foundational L2 usage: buckets, encryption, lifecycle rules |
| 2 | Lambda | ⏳ Planned | Event-driven processing triggered from S3 |
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

Every stack introduced in this series is validated with **cdk-nag** — a set
of CDK Aspects that run the [AWS Solutions](https://github.com/cdklabs/cdk-nag/blob/main/RULES.md)
rule pack (and optionally HIPAA, NIST 800-53, or PCI-DSS packs) against the
synthesized CloudFormation template, flagging violations such as
unencrypted buckets, overly permissive IAM policies, or missing access
logging *before* the stack is ever deployed.

The rule pack is wired into the CDK app's entry point once it exists
(Step 1), applied at the `App` level so it automatically covers every
future stack in the pipeline:

```ts
import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new App();
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

Any violation that is a deliberate, documented trade-off (rather than an
oversight) is suppressed explicitly with a `NagSuppressions` call and a
comment explaining *why* — suppressions are never silent. Each pipeline
step's article calls out any suppressions it introduces.

## Documentation

- [`docs/01-cdk-constructs-and-levels.md`](docs/01-cdk-constructs-and-levels.md) —
  What constructs are and why AWS organizes them into L1, L2, and L3.

More articles are added as each pipeline step is built.

## Repository Structure (evolving)

```
aws-cdk-constructs-masterclass/
├── docs/            # Written articles for the Community Builder series
├── examples/        # One folder per pipeline step (added incrementally)
└── README.md
```

The CDK application scaffold (`bin/`, `lib/`, `package.json`, etc.) is
introduced in Step 1 alongside the first S3 construct.

## License

MIT
