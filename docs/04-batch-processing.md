# Step 3: AWS Batch — When the "Obvious" Serverless Glue Doesn't Fit

> Part 4 of the *AWS CDK Constructs Masterclass* series.

[Step 2](03-lambda-ingest.md) left `IngestFunction` writing a small JSON
manifest to `manifests/` for every object landing under `raw/`. This step
closes the loop: something has to notice that manifest and actually turn
the raw object into something queryable. That "something" is AWS Batch —
and getting there took a wrong turn worth documenting, because the wrong
turn is instructive about how EventBridge's native service integrations
actually work.

## The Shape of Step 3

```
S3 (manifests/)  --notifies-->  ProcessingTrigger (Lambda)  --SubmitJob-->  AWS Batch  --writes-->  S3 (processed/)
```

Two new constructs:

- [`ProcessingJob`](../lib/constructs/processing-job.ts) — the AWS Batch
  infrastructure: a VPC, a Fargate compute environment, a job queue, and
  the job definition. `batch/process/` is the Python job it runs.
- [`ProcessingTrigger`](../lib/constructs/processing-trigger.ts) — a small
  Lambda that submits one Batch job per manifest.

## The Wrong Turn: EventBridge Can't Do This Alone

The instinctive design, and the one this step started with, was **"no
glue Lambda at all"**: enable the bucket's EventBridge notifications, add
an `events.Rule` matching `ObjectCreated` under `manifests/`, and target
it directly at the Batch job queue with `aws-events-targets`' `BatchJob`.
CDK ships exactly that target class for exactly this purpose — it looks
like the idiomatic answer.

It doesn't work here, for a reason visible directly in `aws-cdk-lib`'s own
types. The CloudFormation shape an EventBridge Batch target can populate —
`CfnRule.BatchParametersProperty` — has exactly four fields:
`jobDefinition`, `jobName`, `arrayProperties`, `retryStrategy`. There is no
field for **which object triggered the rule**. Every other EventBridge
target that can carry a dynamic payload (Lambda, Step Functions, SQS, SNS,
Kinesis) does it through a generic `Input`/`InputTransformer` mechanism;
Batch's target shape was never given one. A Batch job submitted this way
runs with entirely static configuration — it has no way to learn the
bucket/key of the manifest that woke it up.

That's fatal for this pipeline: the whole point of the job is "process the
object *this specific manifest* points to." Static parameters can't
express that. So the "no glue Lambda" plan is out, and — because a Lambda
is needed regardless — routing through EventBridge in between adds a rule
and an `eventBridgeEnabled` bucket flag for zero functional benefit. The
design that shipped instead is the same shape Step 2 already established:
**S3 notification straight to a purpose-built Lambda**, which forwards the
one thing Batch's `SubmitJob` API *can* take dynamically — a
`containerOverrides.environment` map — with the manifest's bucket and key.

```ts
await batch.send(new SubmitJobCommand({
  jobQueue: JOB_QUEUE_ARN,
  jobDefinition: JOB_DEFINITION_ARN,
  containerOverrides: {
    environment: [
      { name: 'MANIFEST_BUCKET', value: bucket },
      { name: 'MANIFEST_KEY', value: manifestKey },
    ],
  },
}));
```

**The takeaway for this series:** a construct existing for a use case
(`BatchJob` the EventBridge target exists specifically to queue Batch
jobs) doesn't guarantee it fits *your* use case. Reading the actual
CloudFormation property shape it can populate — one level below the L2 —
answered the question in a way the API documentation's prose didn't make
obvious.

## `ProcessingTrigger`: Zip, on Purpose, in Contrast with Step 2

`IngestFunction` (Step 2) is a container image, as a deliberate exercise
in when that packaging earns its keep. `ProcessingTrigger` is a plain
**Zip** function (`NodejsFunction`) — also deliberate, in the other
direction: it has one small dependency (`@aws-sdk/client-batch`), no
native modules, nothing a container buys it. Zip stays the right default
for the vast majority of functions; Step 2's container image was the
exception, not a new baseline. Putting both packagings in the same stack,
back to back, makes that contrast concrete instead of theoretical.

Its IAM footprint mirrors `IngestFunction`'s own discipline: exactly one
permission, `batch:SubmitJob`, scoped to exactly the one job queue and job
definition it targets (via `EcsJobDefinition.grantSubmitJob()`). It never
touches S3 — it forwards the manifest's bucket/key from the S3 event
record it already received, without reading anything. The manifest's
*contents* (which raw object it describes) are read by the Batch job
itself, not by this function. That split keeps each piece of the pipeline
reading only what it strictly needs to do its own job.

## `ProcessingJob`: Fargate, and a VPC That Only Talks to Itself

AWS Batch has two families of compute environment: EC2-backed (you choose
instance types, patch cadence, scaling) and **Fargate** (no instances to
manage at all). For a small, infrequent job like this one, Fargate removes
an entire category of decisions this masterclass has no reason to make. It
does add one hard requirement Batch's EC2 path shares: **a VPC**. This is
the first VPC in this pipeline.

### Isolated subnets, no NAT Gateway, and VPC endpoints instead

A Fargate task needs to reach three things over the network: the image
registry (to start), CloudWatch Logs (to ship its output), and — for this
job specifically — S3 (to do its actual work). The default way to give a
private subnet that reach is a **NAT Gateway**, but a NAT Gateway bills
hourly *and* per GB processed for as long as it exists, whether or not a
job is running — a poor fit for infrastructure meant to sit mostly idle
between masterclass demos.

This construct instead uses **isolated subnets** (no NAT, no internet
gateway route at all) plus **VPC endpoints** for exactly the three
destinations above:

- **S3 — a Gateway endpoint.** Free, and routed at the VPC route-table
  level rather than through a network interface, so it needs no security
  group of its own.
- **ECR (API + Docker registry) and CloudWatch Logs — Interface
  endpoints.** These *are* billed hourly per endpoint (three of them
  here), which is the real trade-off: cheaper than one NAT Gateway if this
  stack is deployed for a while, but not free the way the S3 endpoint is.
  A truly ephemeral demo (`cdk deploy`, test, `cdk destroy` within the
  hour) pays close to nothing either way; something left running for a
  full billing cycle should compare both against actual AWS pricing for
  its region.

Interface endpoints default to `open: true` — which, easy to miss, opens
port 443 to **the entire VPC CIDR**, not just to the security groups you
pass alongside it. Left on, that quietly widens the intended scope (this
job's own tasks, nothing else) to "anything anyone ever puts in this VPC."
Setting `open: false` and wiring one explicit security-group-to-
security-group rule (`computeSecurityGroup -> endpointsSecurityGroup` on
443) closes that gap — and was only caught by reading the actual
synthesized `SecurityGroupIngress` resource, not by reading the prop
documentation first.

### The job's task role has to be built by hand

`EcsFargateContainerDefinition` auto-creates an `executionRole` (what the
Fargate agent uses to pull the image and write logs) if you don't supply
one — but it does **not** auto-create a `jobRole` (what the container's
own AWS SDK calls authenticate as). That default makes sense once you
notice it: the execution role's permissions are the same for every job
that will ever use this construct, but the job role's permissions are
entirely about what *this specific job's code* does — CDK has no way to
guess that. `ProcessingJob` creates it explicitly and exposes it as
`jobRole`, and `DataPipelineStack` grants it exactly three scoped
permissions: read `manifests/*`, read `raw/*`, write `processed/*`. Same
least-privilege shape as `IngestFunction`'s single `manifests/*` grant in
Step 2 — just three prefixes instead of one, because this job's work
spans reading two and writing a third.

## cdk-nag's Findings for Step 3

| Finding | Where | Verdict |
|---|---|---|
| `AwsSolutions-VPC7` — no VPC Flow Logs | `ProcessingJob`'s VPC | Acknowledged |
| `AwsSolutions-IAM5[Resource::*]` — `ecr:GetAuthorizationToken` | The auto-created container execution role | Acknowledged |
| `AwsSolutions-IAM5[Action::s3:GetBucket*\|GetObject*\|List*]` | The job role's `manifests/*`/`raw/*` read grant | Acknowledged |
| `AwsSolutions-IAM5[Action::s3:Abort*]` | The job role's `processed/*` write grant | Acknowledged |
| `AwsSolutions-IAM5[Resource::.../manifests/*\|raw/*\|processed/*]` | The job role's three prefix-scoped grants | Acknowledged |
| `AwsSolutions-IAM4` — `AWSLambdaBasicExecutionRole` | `ProcessingTrigger`'s role | Already acknowledged at the stack level (Step 2) |

Two of these are new shapes for this series, not repeats of Step 2's
reasoning:

**`AwsSolutions-VPC7` (no Flow Logs)** is acknowledged, not fixed, for a
reason specific to what this VPC *is*: a single-purpose network for one
construct's own ephemeral Fargate tasks, with no other workloads, no
inbound exposure, and no route to the internet in the first place.
Enabling Flow Logs would add an ongoing CloudWatch Logs cost with nothing
concrete to show for it in this walkthrough. That reasoning is scoped to
*this* VPC — a shared, multi-tenant, or internet-facing VPC should still
turn Flow Logs on.

**`ecr:GetAuthorizationToken`'s `Resource: "*"`** is the same category of
finding as Step 2's X-Ray wildcard: an AWS API with no resource-level
scoping at all. You cannot name a specific ECR repository (or anything
else) as the resource for the *authentication* call that happens before
you can name a repository — `Resource: "*"` is the only syntactically
valid form this permission can take.

Everything else — the `s3:GetBucket*`/`GetObject*`/`List*`/`Abort*` action
bundling and the `manifests/*`/`raw/*`/`processed/*` prefix scopes — is
the exact same shape as Step 2's `manifests/*` grant, just applied to
three prefixes on one role instead of one prefix on one role.

## What's Next

Step 4 introduces Athena: pointing a Glue Data Catalog table at the
`processed/` prefix this job now writes, and querying it directly with
SQL — no new compute to manage, just a schema laid over what's already in
S3.
