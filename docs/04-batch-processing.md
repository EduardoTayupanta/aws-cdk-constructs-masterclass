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

### An accepted trade-off: no duplicate-submission protection

`SubmitJobCommand` is called with no deterministic `jobName` and no check
for an already-running job against the same manifest. If S3 ever redelivers
the same `ObjectCreated` event — its own delivery guarantee is "at least
once," not "exactly once" — this function will submit the same processing
job twice. That's a deliberate, accepted gap, not an oversight: the job
itself is idempotent in the way that matters, since both runs read the same
`raw/` object and write to the same `processed/<key>` destination, so a
duplicate submission costs a second Fargate task run but never produces
inconsistent output. Closing it properly (a deterministic `jobName` derived
from the manifest key, or a pre-submission lookup) is a real option for a
production version of this pipeline — it just isn't free, and wasn't worth
the extra moving parts for this masterclass.

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
destinations above.

A second, related cost choice: the VPC is built with `maxAzs: 1`, not
CDK's usual default of 2. A second AZ buys high availability for a service
that's actually running redundantly across it — this VPC exists to run one
ephemeral Fargate task at a time, not a long-lived service, so there's
nothing here for a second AZ to make more available. What it *would* buy is
cost: every interface endpoint below provisions one billable ENI per AZ it's
deployed into, so two AZs would mean six billable interface endpoints
(three services × two AZs) instead of the three this construct actually
pays for.

VPC endpoints, one per destination:

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

## Failure Alerts: Making Silent Drops Visible

Every stage of this pipeline can fail on its own: `IngestFunction` or
`ProcessingTrigger` can throw after S3 invokes them asynchronously, and the
Batch job itself can fail after exhausting its `retryAttempts: 2`. Without
anything watching for that, each of those failures just... vanishes — no
error surfaces anywhere a human would see it, the object that triggered it
silently never makes it to `processed/`, and nothing about the pipeline's
own infrastructure tells you that happened.

`DataPipelineStack` now wires up one shared answer to all three cases: a
single, KMS-encrypted SNS topic (`this.alertsTopic`, construct ID
`PipelineAlerts`, backed by its own `PipelineAlertsKey`) that becomes the
landing spot for every kind of failure this pipeline can produce:

- **Both Lambdas' asynchronous invocation failures.** S3 invokes
  `IngestFunction` and `ProcessingTrigger` asynchronously, so each gets an
  `onFailure` destination (`configureAsyncInvoke({ onFailure:
  new SnsDestination(this.alertsTopic) })`) pointed at the same topic —
  the minimum needed to know Lambda gave up retrying an event.
- **AWS Batch job failures.** A `ProcessingJobFailureRule` EventBridge rule
  matches `Batch Job State Change` events with `status: FAILED`, scoped to
  this pipeline's own job queue (the default event bus is account-wide and
  could otherwise carry failures from unrelated Batch queues), and targets
  the same topic.

The topic itself gets the same defensive posture as the pipeline's other
security-sensitive resources: encrypted at rest with a customer-managed KMS
key (satisfying `AwsSolutions-SNS2`), which is also what lets the IAM
grants that publish to it be scoped to that key's own ARN instead of a
`key/*` wildcard, and a resource policy that denies any publish over a
non-TLS connection (`AwsSolutions-SNS3`) — the same deny-if-insecure shape
`DataLakeBucket` already uses for its own bucket policy. Neither rule shows
up in the findings table below: both are satisfied outright, with nothing
to acknowledge.

**A second, less obvious gap: EventBridge's own grant needed narrowing by
hand.** Adding `new SnsTopic(this.alertsTopic)` as the rule's target makes
CDK grant `events.amazonaws.com` publish access to the topic (and, via the
topic's `masterKey`, `kms:Decrypt`/`kms:GenerateDataKey*` on
`PipelineAlertsKey`) automatically — but the actual permissions that land
in the synthesized template carry no `aws:SourceArn` condition.
`aws-events-targets`' `SqsQueue` target scopes that same kind of
grant to the specific rule; its `SnsTopic` target doesn't. Left alone, any
EventBridge rule in any AWS account that learned this topic's ARN could
publish to it. Two explicit `Deny` statements (one on the topic, one on the
key), each conditioned on `aws:SourceArn` not matching
`ProcessingJobFailureRule`'s own ARN, close that gap without touching the
automatic `Allow` — an explicit `Deny` only fires when its own condition is
true, so the legitimate rule keeps working. cdk-nag's AWS Solutions pack
has no rule that catches this (it doesn't inspect source-ARN conditions on
service-principal grants), so this was only visible by reading the
synthesized IAM policy directly, the same way Step 3's `open: true` VPC
endpoint default only surfaced by reading the synthesized security group
rule instead of the prop documentation.

**This stack does not subscribe anything to the topic.** Wiring your own
email address, an SMS number, a Slack webhook (via SNS-to-Chatbot or a
subscriber Lambda), or anything else you'd actually want to be notified on
is left to you — `alertsTopic` is exposed as a public, read-only property
of `DataPipelineStack` specifically so a real deployment can add its own
`Subscription` without this masterclass making that choice on your behalf.
Without at least one subscription, the topic still does its job of *not
silently dropping* a failure — it just accumulates unread notifications
until someone subscribes to it.

## cdk-nag's Findings for Step 3

| Finding | Where | Verdict |
|---|---|---|
| `AwsSolutions-VPC7` — no VPC Flow Logs | `ProcessingJob`'s VPC | Acknowledged |
| `AwsSolutions-IAM5[Resource::*]` — `ecr:GetAuthorizationToken` | The auto-created container execution role | Acknowledged |
| `AwsSolutions-IAM5[Resource::*]` — X-Ray tracing | `ProcessingTrigger`'s function | Acknowledged |
| `AwsSolutions-IAM4` — `AWSLambdaBasicExecutionRole` | `ProcessingTrigger`'s role | Already acknowledged at the stack level (Step 2) |
| `AwsSolutions-IAM5[Action::s3:GetBucket*]` | The job role's `manifests/*`/`raw/*` read grant | Acknowledged |
| `AwsSolutions-IAM5[Action::s3:GetObject*]` | The job role's `manifests/*`/`raw/*` read grant | Acknowledged |
| `AwsSolutions-IAM5[Action::s3:List*]` | The job role's `manifests/*`/`raw/*` read grant | Acknowledged |
| `AwsSolutions-IAM5[Action::s3:Abort*]` | The job role's `processed/*` write grant | Acknowledged |
| `AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/manifests/*]` | The job role's `manifests/*` read grant | Acknowledged |
| `AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/raw/*]` | The job role's `raw/*` read grant | Acknowledged |
| `AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/processed/*]` | The job role's `processed/*` write grant | Acknowledged |
| `AwsSolutions-IAM5[Action::kms:GenerateDataKey*]` | `IngestFunction`'s and `ProcessingTrigger`'s functions (each `onFailure` destination publishing to the encrypted `PipelineAlerts` topic) | Acknowledged (both) |

A few of these are new shapes for this series, not repeats of Step 2's
reasoning:

**`AwsSolutions-VPC7` (no Flow Logs)** is acknowledged, not fixed, for a
reason specific to what this VPC *is*: a single-purpose network for one
construct's own ephemeral Fargate tasks, with no other workloads, no
inbound exposure, and no route to the internet in the first place.
Enabling Flow Logs would add an ongoing CloudWatch Logs cost with nothing
concrete to show for it in this walkthrough. That reasoning is scoped to
*this* VPC — a shared, multi-tenant, or internet-facing VPC should still
turn Flow Logs on.

**`ecr:GetAuthorizationToken`'s `Resource: "*"`**, and `ProcessingTrigger`'s
own X-Ray finding, are the same category as Step 2's X-Ray wildcard: AWS
APIs with no resource-level scoping at all. You cannot name a specific ECR
repository (or anything else) as the resource for the *authentication*
call that happens before you can name a repository, and X-Ray's tracing
calls have no ARN to scope to either — `Resource: "*"` is the only
syntactically valid form either permission can take.

**The job role's read grant isn't uniformly prefix-scoped, and the
acknowledgment says so honestly.** `s3:GetObject*` and `s3:Abort*` stay
confined to the `manifests/*`, `raw/*`, and `processed/*` resource ARNs
listed in the table above — the whole point of `grantRead()`/`grantPut()`'s
key-pattern argument. `s3:GetBucket*` and `s3:List*`, though, are
bucket-level actions with no per-key granularity in IAM at all: there's no
way to scope `s3:ListBucket` to "only list keys under this prefix," so
those two apply to the *whole bucket* ARN, not the three prefix ARNs below
them. That's a real, if narrow, widening — the job role can enumerate every
key name in the bucket and read bucket-level metadata (e.g.
`GetBucketLocation`) — but it still can't read or write object *content*
outside the three prefixes it was actually granted.

**`kms:GenerateDataKey*`** is new, introduced by the failure-alerts topic
above: publishing an encrypted SNS message requires encrypting it with the
topic's own KMS key first, and `SnsDestination`'s grant pulls in this
action via `Key.grantEncrypt()`. Like `ecr:GetAuthorizationToken` and X-Ray
above, it has no non-wildcard form — but unlike those two, its *resource*
side is properly scoped to `PipelineAlertsKey`'s own ARN, not `key/*`,
which is what a customer-managed key (instead of the `alias/aws/sns`
AWS-managed one) buys here. The identical finding is acknowledged on
`IngestFunction`'s function too, for the same reason.

## What's Next

[Step 4](05-athena-glue.md) introduces Athena: pointing a Glue Data Catalog
table at the `processed/` prefix this job now writes, and querying it
directly with SQL — no new compute to manage, just a schema laid over
what's already in S3.
