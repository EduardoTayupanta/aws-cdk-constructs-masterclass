# Step 2: Lambda — Reacting to S3, and cdk-nag's First Real Trade-offs

> Part 3 of the *AWS CDK Constructs Masterclass* series.

[Step 1](01-s3-foundations.md) built `RawDataBucket`, a data-lake-grade S3
bucket, with zero cdk-nag suppressions. This step wires the pipeline's
second stage — `S3 → Lambda` — and, as predicted at the end of that
article, is where the masterclass hits its first **genuine, justified**
cdk-nag findings instead of avoidable ones.

## The Construct: `IngestFunction`

[`IngestFunction`](../lib/constructs/ingest-function.ts) wraps a
`DockerImageFunction` — the Lambda L2 for **container image** packaging,
as opposed to the more commonly-reached-for Zip packaging (`Function` /
`NodejsFunction`). `lambda/ingest/` is its own self-contained mini-project
(own `package.json`, own `Dockerfile`), independent of the CDK app's
toolchain — a deliberate choice, discussed below.

The handler itself ([`lambda/ingest/index.ts`](../lambda/ingest/index.ts))
is deliberately narrow: for every object created under `raw/`, it writes a
small JSON manifest (`bucket`, `sourceKey`, `sizeBytes`, `eventName`,
`eventTime`) to `manifests/` in the *same* bucket. It never reads the
object's contents — everything it
needs is already on the S3 event record — which keeps its IAM footprint to
exactly one action on exactly one prefix. That manifest is what Step 3
(AWS Batch) and Step 4 (Athena) build on next.

### Zip vs. container image, and why this function moved

The function started out as a `NodejsFunction` (Zip packaging, bundled
in-process with esbuild at synth time) — the right default for a small
utility function with no unusual dependencies. It was converted to a
container image as a deliberate exercise in *when the other L2 earns its
keep*, not because this particular handler outgrew Zip's limits. The real
trade-off:

- **Zip (`NodejsFunction`/`Function`)** — bundled by the CDK app's own
  toolchain, deploys in milliseconds, capped at 250 MB unzipped. Right
  default for most functions, including this one.
- **Container image (`DockerImageFunction`)** — up to 10 GB, full control
  over the OS layer and native dependencies, but the function becomes its
  own independently-built artifact: its own `package.json`, its own
  `Dockerfile`, built with `docker build` rather than the app's bundler.

[`lambda/ingest/Dockerfile`](../lambda/ingest/Dockerfile) is a two-stage
build: a plain Node image installs the one runtime dependency
(`@aws-sdk/client-s3`) and bundles the handler with esbuild, then only the
single resulting `index.js` file is copied into AWS's own
`public.ecr.aws/lambda/nodejs:22` base image. No `node_modules`, no
TypeScript source, and no build tooling cross into the deployed image.

### A pleasant surprise: `cdk synth` never touches Docker

The expectation going in was that switching to a container image would
make Docker a hard requirement for *everything* — `npm run build`,
`npm test`, `cdk synth`, all of it. That turned out to be wrong.
`DockerImageCode.fromImageAsset()` only **stages** the build context
(copies `lambda/ingest/` into `cdk.out/asset.<content-hash>/` and records
it in the assets manifest) during synthesis; the actual `docker build` /
`docker push` is deferred entirely to **asset publishing** — which only
happens on `cdk deploy` (or an explicit `cdk-assets publish`). Confirmed
by inspecting `cdk.out/DataPipelineStack.assets.json` after a synth on a
machine with no Docker installed at all:

```json
"dockerImages": {
  "<hash>": {
    "displayName": "IngestFunction/Resource/AssetImage",
    "source": { "directory": "asset.<hash>", "platform": "linux/arm64" },
    "destinations": { "...": { "repositoryName": "cdk-hnb659fds-container-assets-...", "imageTag": "<hash>" } }
  }
}
```

So the actual constraint is narrower than it first looked: **Docker (or a
compatible builder such as Finch/Podman via `CDK_DOCKER`) is only required
at `cdk deploy` time**, not for day-to-day development, type-checking, or
this project's own test suite.

### Validating the image locally, without a real deploy

`cdk synth` skipping Docker is convenient, but it also means synth alone
proves nothing about whether the image actually *builds* or *runs*. Both
are cheap to check locally, without touching AWS at all, using the same
build context CDK stages (`lambda/ingest/`) and the Lambda Runtime
Interface Emulator (RIE) baked into `public.ecr.aws/lambda/nodejs:22`:

```bash
# 1. Build the same context cdk deploy would, for the same architecture
#    the construct requests (Architecture.ARM_64) — Docker Desktop cross-
#    builds it via QEMU even on an amd64 host.
docker build --platform linux/arm64 -t ingest-function-test lambda/ingest

# 2. Run it — the base image's entrypoint starts the RIE on port 8080.
docker run -d --name ingest-fn-test -p 9000:8080 --platform linux/arm64 \
  -e AWS_REGION=us-east-1 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test \
  ingest-function-test

# 3. Invoke it through the RIE's local endpoint with a synthetic S3 event.
curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" -d '{
  "Records": [{
    "eventTime": "2026-09-14T12:00:00.000Z",
    "eventName": "ObjectCreated:Put",
    "s3": {
      "bucket": { "name": "test-data-lake-bucket" },
      "object": { "key": "raw/sample.json", "size": 1234 }
    }
  }]
}'
```

The build succeeds and the invoke gets as far as it possibly can without
real credentials: the logs show the handler correctly deriving the
manifest key (`raw/sample.json` → `manifests/sample.json.json`) and then
issuing a real `PutObject` call to S3, which AWS rejects with
`InvalidAccessKeyId` — a genuine API error, not a local/mocking one. That
error is actually the useful signal here: it proves the request reached
S3 at all, which is as far as this handler's logic can be exercised
without a real bucket and real credentials. Two things are worth noting
about the run itself:

- `AWS_REGION` had to be set explicitly. A deployed Lambda always has it
  injected by the platform; the RIE does not, so omitting it fails
  earlier with `Region is missing` — a local-harness gap, not a bug.
- No AWS credentials of any kind are required to prove the *build*
  works — only the invoke step needs them (even fake ones), because the
  AWS SDK client is constructed lazily, on the first S3 call.

This closes the gap `cdk synth` leaves open: synth proves the app
*assembles* correctly and stages the right build context; this local
Docker run proves the image *builds* and the bundled handler *executes*
correctly inside it — the two things a real `cdk deploy` would otherwise
be the first opportunity to discover.

### Cleanup: `cdk destroy` isn't the whole story anymore

Once a `cdk deploy` does run, the built image is pushed to the **CDK
bootstrap's shared ECR asset repository**
(`cdk-hnb659fds-container-assets-<account>-<region>`) — infrastructure
that belongs to the *bootstrap* stack, shared across every CDK app in that
account/region, not to `DataPipelineStack`. `cdk destroy` only tears down
resources this stack owns, so the pushed image is **not** removed by it.
Full cleanup for this project's "everything destroyable via CDK" goal is
two commands, not one:

```bash
npx cdk destroy   # removes DataPipelineStack's own resources
npx cdk gc        # removes assets (including this image) no stack references anymore
```

`cdk gc` is a stable CDK CLI command purpose-built for this: it finds
assets in the bootstrap bucket/repository that no currently-deployed stack
references and deletes them. It's the CDK-native equivalent of `docker
system prune`, scoped to what CDK itself published.

### Another deprecation gotcha: `logRetention`

The construct creates its own `LogGroup` and passes it via the `logGroup`
prop, instead of the shorter-looking `logRetention` prop on
`NodejsFunction`. `logRetention` is deprecated: under the hood it used to
provision an entire extra custom-resource Lambda just to call
`PutRetentionPolicy` after the fact. An explicit `LogGroup` gets the same
retention control (and lets this project apply its usual `removalPolicy`
convention) without that hidden resource.

## cdk-nag's First Real Findings

Wiring the function up (`grantPut` for the manifest prefix, plus
`bucket.addEventNotification(...)` to invoke it) produced **four** cdk-nag
findings — the first ones in this series that are genuine trade-offs
rather than a fixable mistake:

| Finding | Where | Verdict |
|---|---|---|
| `AwsSolutions-IAM4` — AWS managed policy (`AWSLambdaBasicExecutionRole`) | `IngestFunction`'s role, **and** CDK's own `BucketNotificationsHandler` custom resource | Acknowledged |
| `AwsSolutions-IAM5[Resource::*]` | X-Ray tracing permissions | Acknowledged |
| `AwsSolutions-IAM5[Action::s3:Abort*]` | The `manifests/*` write grant | Acknowledged |
| `AwsSolutions-IAM5[Resource::.../manifests/*]` | The `manifests/*` write grant | Acknowledged |

### Why `AWSLambdaBasicExecutionRole` is fine here

`AwsSolutions-IAM4` flags any use of an AWS-*managed* IAM policy, on the
theory that a managed policy might grant more than a specific role needs.
`AWSLambdaBasicExecutionRole` grants exactly three actions:
`logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`. Since
this function already writes to an explicit, retention-controlled
`LogGroup`, replacing the managed policy with a hand-authored inline
policy would grant the *same three actions* — more code, identical risk.
The acknowledgment says exactly that:

```ts
Validations.of(this).acknowledge({
  id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
  reason: 'AWSLambdaBasicExecutionRole only grants CloudWatch Logs write permissions... ',
});
```

This one is acknowledged once, at the **stack** level, not inside
`IngestFunction`. The same managed policy also ends up on the role of
`BucketNotificationsHandler...` — a singleton custom resource
`addEventNotification()` provisions internally to configure the bucket's
event notification. That resource is generated by `aws-cdk-lib` itself,
not authored here, and its exact construct path includes a
content hash — acknowledging at the stack level (an ancestor of
*everything*) covers both occurrences without depending on that
generated, unstable path.

### Why the X-Ray and S3-prefix "wildcards" are fine here

`AwsSolutions-IAM5` flags any IAM statement containing a `*`, in either
`Action` or `Resource` — a blunt but useful check. Two different `*`s show
up here, for two different, both-legitimate reasons:

- **`Resource: "*"` for X-Ray.** `xray:PutTraceSegments` and
  `xray:PutTelemetryRecords` are not resource-scopable actions — the X-Ray
  API itself has no ARN to scope them to. This `*` is what AWS requires for
  tracing, not a wildcard this project chose.
- **`manifests/*` and `s3:Abort*` from `Bucket.grantPut(fn, 'manifests/*')`.**
  The whole point of passing a key pattern to `grantPut()` is to scope the
  grant to one prefix instead of the entire bucket — cdk-nag's rule just
  can't tell "a deliberately scoped prefix" apart from "no scoping at
  all," because both contain the character `*`. `s3:Abort*` is bundled in
  by CDK so the function can clean up a multipart upload it started
  itself; it's already covered by the same prefix scope.

**The takeaway for this series:** cdk-nag's job isn't to produce a
zero-`*` policy — some `*`s are unavoidable (X-Ray) or are themselves the
security control (a prefix scope). Its job is to force every `*` to be
looked at and written down, instead of accumulating silently. Four
findings, four one-sentence justifications, reviewable in a diff — that's
the mechanism working as intended, not a rule being "worked around."

## What's Next

[Step 3](03-batch-processing.md) introduces AWS Batch — the first step
where the *application* code is Python rather than TypeScript, while the
infrastructure defining it stays CDK/TypeScript. It processes the objects
the manifests point to.
