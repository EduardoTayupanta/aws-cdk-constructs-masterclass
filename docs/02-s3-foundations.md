# Step 1: S3 Foundations — an L2 Construct, Verified with cdk-nag

> Part 2 of the *AWS CDK Constructs Masterclass* series.

[Part 1](01-cdk-constructs-and-levels.md) covered *why* CDK has L1/L2/L3
constructs. This part puts that theory to work: the first real piece of the
masterclass pipeline (`S3 → Lambda → AWS Batch → Athena`) is a bucket that
receives raw data — built as an L2 composition, and checked automatically
against the AWS Solutions rule pack with **cdk-nag**.

## The Construct: `DataLakeBucket`

Rather than calling `new Bucket(...)` inline in the stack, this step
introduces [`DataLakeBucket`](../lib/constructs/data-lake-bucket.ts) — a
small custom construct wrapping **two** L2 `Bucket`s behind one
intent-revealing API:

```ts
const rawDataBucket = new DataLakeBucket(this, 'RawDataBucket', {
  removalPolicy: RemovalPolicy.DESTROY, // demo-only, see below
  autoDeleteObjects: true,
});
```

Internally, it wires up:

- **Encryption** (`BucketEncryption.S3_MANAGED`) and **TLS enforcement**
  (`enforceSSL: true`) — non-negotiable defaults for any data bucket.
- **`BlockPublicAccess.BLOCK_ALL`** and
  **`ObjectOwnership.BUCKET_OWNER_ENFORCED`** — no ACLs, no accidental
  public exposure.
- **Versioning**, so an overwritten or deleted object is recoverable.
- A **lifecycle rule** transitioning objects to `INFREQUENT_ACCESS` after 30
  days — the kind of cost-conscious default an L1 bucket would never give
  you for free.
- **Server access logging**, pointed at a second, dedicated
  `AccessLogsBucket` created by the same construct.

This is what an "L3-flavored" building block looks like even at a small
scale: two L2 `Bucket`s, composed behind one call, so every future stack
that needs a pipeline-grade bucket gets all of this by writing one line
instead of remembering eight properties.

### A deliberate, documented choice: `RemovalPolicy`

The construct defaults to `RemovalPolicy.RETAIN` — a production data bucket
should never disappear because someone ran `cdk destroy`. The masterclass
stack overrides that explicitly to `DESTROY` (with `autoDeleteObjects:
true`) purely so the demo is easy to tear down while following along. The
override happens at the call site, not inside the construct, so the
trade-off is visible in the stack's own code instead of hidden in a
"convenient" default.

## Verifying It with cdk-nag

The [README](../README.md#security--compliance-cdk-nag) already committed
this repo to running every stack through **cdk-nag**'s AWS Solutions rule
pack. Here's what that looks like once the CDK app actually exists.

### The API changed under our feet: `cdk-nag` 3.x

Most cdk-nag material you'll find online still shows the 2.x pattern:

```ts
// cdk-nag 2.x — outdated, shown for contrast only
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
NagSuppressions.addResourceSuppressions(bucket, [{ id: '...', reason: '...' }]);
```

cdk-nag 3.x (installed here) moved to CDK's newer, native **Validations**
API — a `Cfn`-agnostic mechanism for registering *policy validation
plugins* that run during synthesis, instead of hijacking the general-purpose
Aspects visitor:

```ts
// bin/app.ts
import { Validations } from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
```

Acknowledging (suppressing) a specific finding also moved, from
`NagSuppressions.addResourceSuppressions(...)` to the construct-scoped
`Validations.of(construct).acknowledge({ id, reason })`. Same idea — a
documented, per-resource override — new home for it.

**Lesson for the masterclass:** always check a library's own README/API.md
against the version actually installed. A two-year-old blog post's code
sample can be quietly wrong for a current major version.

### Zero suppressions needed — and why that's the interesting part

The natural instinct when building `DataLakeBucket` was: "the
`AccessLogsBucket` doesn't have its *own* access logging configured — that
will trigger `AwsSolutions-S1`, so I'll need to acknowledge it with a
'this bucket is itself a log destination' justification."

That turned out to be unnecessary. cdk-nag's `AwsSolutions-S1` rule already
walks every bucket in the stack and checks whether some *other* bucket
names it as a `destinationBucketName` — if so, it treats the log bucket as
compliant automatically, no suppression required. Reading the rule's
source before reaching for `acknowledge()` avoided adding a suppression for
a violation that was never going to fire.

The result: Step 1 ships with **no suppressions at all**. That's a
deliberate milestone worth calling out — a future step (Lambda, most
likely, once CDK's own generated log-group or IAM policies produce a
realistic wildcard-permission finding) is where the masterclass will show
an *actual* justified `acknowledge()` call.

### Testing cdk-nag directly, without a full `cdk synth`

The other thing that changed with the 3.x API: NagPack no longer writes
findings to CDK `Annotations`, so `Annotations.fromStack(stack)` — the
common 2.x-era unit test pattern — silently finds nothing under 3.x. Its
own source points at the real entry point for tests:

```ts
// test/data-pipeline-stack.test.ts
const report = new AwsSolutionsChecks().validateScope(stack);
expect(report.success).toBe(true);
```

`validateScope()` runs the same rule pack directly against a construct
tree and returns `{ success, violations }` — no synthesis pipeline, no CLI,
no cloud assembly directory required.

### A gotcha: `cdk.json` feature flags don't reach Jest for free

While wiring this up, `npm test` failed with an S3-internal validation
error (`objectOwnership must be set to "ObjectWriter" when accessControl is
"LogDeliveryWrite"`) that never showed up under `cdk synth`. The cause:
`cdk.json`'s `context` block — including
`@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy`, which switches S3 access
logging to the modern bucket-policy delivery method instead of the legacy
ACL-based one — is only read by the **`cdk` CLI**. A plain `new App()`
inside a test file starts with none of it.

The fix is to load the same file the CLI would:

```ts
import * as cdkJson from '../cdk.json';

const app = new App({ context: cdkJson.context });
```

Without this, a test suite can pass or fail based on flags a real `cdk
deploy` would have applied — silently testing a different app than the one
that ships.

## What's Next

Step 2 adds a Lambda function triggered by objects landing in
`RawDataBucket`, and is the more likely place for the masterclass' first
genuine, justified cdk-nag suppression.
