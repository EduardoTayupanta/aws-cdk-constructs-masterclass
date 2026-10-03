# Understanding AWS CDK Constructs — and Why They Have Levels

> Part 1 of the *AWS CDK Constructs Masterclass* series.

If you've spent any time with the AWS Cloud Development Kit (CDK), you've
run into the terms **L1**, **L2**, and **L3 construct**. They show up in the
official docs, in construct library names (`aws-ecs-patterns`), and in almost
every CDK talk. This article explains what a construct actually is, why AWS
organized them into levels instead of a single flat API, and how to decide
which level to reach for in your own infrastructure code.

This is the conceptual foundation for the rest of the series, where we'll
build a small, real data pipeline — **S3 → Lambda → AWS Batch (Python) →
Athena** — one construct at a time.

## What Is a Construct?

A **construct** is the basic building block of a CDK application: a class
that encapsulates everything needed to create one or more AWS resources,
plus the configuration logic that wires them together. Every single object
in a CDK app is a construct — including the `App` and every `Stack`.

Constructs are organized in a tree:

```
App
 └── Stack
      ├── Construct (e.g. an S3 Bucket)
      ├── Construct (e.g. a Lambda Function)
      └── Construct
           └── Nested Construct
```

When you run `cdk synth`, CDK walks this tree and each construct contributes
one or more resources to the resulting CloudFormation template. The tree
structure is also how CDK generates stable logical IDs, scopes permissions,
and lets you compose constructs inside other constructs indefinitely — a
construct can contain constructs, which can contain more constructs.

This composability is the entire point: instead of one giant, flat
CloudFormation template, you get an object-oriented API where infrastructure
is expressed as reusable, testable, versionable code.

## Why Levels Exist

AWS didn't invent three levels arbitrarily — each level solves a **different
problem** for a different situation, trading off control against
convenience:

| Level | What it wraps | Problem it solves |
|-------|---------------|--------------------|
| **L1** | A single CloudFormation resource | Full control, day-one coverage for every AWS resource |
| **L2** | One or more L1s | Safe defaults, less boilerplate, fewer security mistakes |
| **L3** | Multiple L2s | Reusable, opinionated architecture for a whole use case |

Think of it as a spectrum of **abstraction vs. control**: as you move from
L1 to L3, you write less code and make fewer decisions, but you also give up
fine-grained control over individual properties. Understanding this
trade-off is what lets you pick the right tool instead of defaulting to
"whatever the tutorial used."

### L1 — CFN Resources

L1 constructs (named `Cfn*`, e.g. `CfnBucket`, `CfnFunction`) are generated
**automatically** from the AWS CloudFormation resource specification. They
are a direct, 1:1 mapping to a CloudFormation resource type: every property
CloudFormation supports is exposed, with no extra defaults, no convenience
methods, and no validation beyond what CloudFormation itself enforces.

```ts
import { CfnBucket } from 'aws-cdk-lib/aws-s3';

new CfnBucket(this, 'RawBucket', {
  bucketName: 'my-raw-data-bucket',
  versioningConfiguration: {
    status: 'Enabled',
  },
  // Every property must be set explicitly — nothing is inferred for you.
});
```

**When to reach for L1:**
- The AWS service is brand new and doesn't have an L2 yet.
- You need a CloudFormation property that the L2 wrapper doesn't expose.
- You're intentionally building your own abstraction from scratch and want
  zero hidden behavior.

The cost is that you own every decision CloudFormation would otherwise let
you skip — including the ones that are easy to get wrong, like bucket
encryption or IAM trust policies.

### L2 — Curated Resources

L2 constructs are the ones you use for the vast majority of everyday CDK
code: `Bucket`, `Function`, `Table`, `Vpc`, and so on. Internally, an L2
wraps one or more L1s and adds:

- **Sensible defaults** (e.g. `Bucket` blocks public access by default).
- **Convenience methods** that encode best practices, such as
  `bucket.grantRead(fn)` generating the correct least-privilege IAM policy
  instead of you writing a policy document by hand.
- **An intent-based API** — you say *what* you want, not which
  CloudFormation property to set.

```ts
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';

const rawBucket = new Bucket(this, 'RawBucket', {
  versioned: true,
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL, // already the default
  enforceSSL: true,
});

// Later, granting access is a single line — CDK writes the IAM policy:
rawBucket.grantRead(myLambdaFunction);
```

Notice what didn't have to be written: no bucket policy JSON, no IAM
statement, no ARN string concatenation. That's the entire value
proposition of L2 — it removes an enormous amount of repetitive,
error-prone boilerplate while still giving you an escape hatch (most L2s
expose `.node.defaultChild` to reach the underlying L1 when you need a
property the L2 doesn't surface).

### L3 — Patterns

L3 constructs, usually called **patterns**, compose several L2s into a
complete, opinionated architecture for a specific use case rather than a
single AWS resource. The best-known official example is
`aws-ecs-patterns.ApplicationLoadBalancedFargateService`, which wires up a
load balancer, a Fargate service, a task definition, and the security
groups between them in one construct.

```ts
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';

new ApplicationLoadBalancedFargateService(this, 'Service', {
  cluster,
  taskImageOptions: { image: ContainerImage.fromRegistry('amazon/amazon-ecs-sample') },
  publicLoadBalancer: true,
});
```

L3 constructs don't have to come from AWS. This is where **your own**
reusable constructs live: an internal library construct that always creates
an S3 bucket + a Lambda function + the event notification wiring between
them, published once and consumed by every team, is an L3 pattern. This is
the real payoff of "infrastructure as code" at an organizational level —
architecture becomes a shareable, versioned artifact instead of tribal
knowledge repeated in every stack.

## Choosing the Right Level

A practical rule of thumb:

1. **Default to L2.** It covers almost every case and encodes AWS's own
   security and reliability guidance.
2. **Drop to L1** only when an L2 doesn't exist yet, or when you need a
   specific CloudFormation property an L2 doesn't expose — and even then,
   prefer reaching into `construct.node.defaultChild` from an existing L2
   over building the whole resource in L1.
3. **Reach for or build an L3** when you notice you're repeating the same
   combination of L2s (and the IAM/networking glue between them) across
   more than one stack. That repetition is the signal that the pattern
   deserves to become its own construct.

## What's Next in This Masterclass

This series treats the repository as a **living project**: each part adds
one new construct to a single, growing data pipeline instead of a
disconnected list of demos.

| Step | Service | Construct focus |
|------|---------|------------------|
| 1 | **S3** | Foundational L2 usage: buckets, encryption, lifecycle rules |
| 2 | **Lambda** | Event-driven processing triggered from S3 |
| 3 | **AWS Batch** | Heavier processing via a Python job, defined with CDK/TypeScript |
| 4 | **Athena** | Querying the pipeline's output with a Glue Data Catalog + Athena workgroup |

Infrastructure code throughout the series is written in **TypeScript**.
**Python** is used only where it belongs — inside the AWS Batch job's own
container image — not as an alternative CDK language.

## Summary

- A construct is the unit of composition in CDK; everything in a CDK app is
  one, arranged in a tree.
- Levels are not a versioning scheme — they are three different trade-offs
  between control and convenience: **L1** (raw CloudFormation, full
  control), **L2** (curated defaults, less boilerplate), **L3** (opinionated
  architecture, maximum reuse).
- Default to L2, drop to L1 for gaps, and graduate repeated patterns into
  your own L3 constructs.
