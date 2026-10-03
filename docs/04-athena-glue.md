# Step 4: Athena — Querying What Was Never Given a Schema

> Part 5 of the *AWS CDK Constructs Masterclass* series.

[Step 3](03-batch-processing.md) left `ProcessingJob` writing one JSON
Lines object under `processed/` per raw object — deliberately schema-free,
since `process.py` promises nothing about its rows beyond "one JSON value
per line" (see its docstring). Step 4 closes the pipeline's loop: put a
queryable schema over that output with **AWS Glue Data Catalog** and
**Amazon Athena**, without pretending the underlying data is more
structured than it actually is.

## The Shape of Step 4

```
S3 (processed/)  --catalogs-->  Glue Database + Table  --queried by-->  Athena
```

One new construct, [`QueryCatalog`](../lib/constructs/query-catalog.ts):
a Glue database, a Glue table pointed at `processed/`, and an Athena
workgroup to run queries in. No new compute, no new Lambda, no new IAM
role for a service to assume — this step is closer to "declare a schema"
than "deploy infrastructure."

## A New Kind of Gap: No L2 to Reach For

Every construct so far has had an `aws-cdk-lib` L2 available: `Bucket`,
`NodejsFunction`, `DockerImageFunction`, `Vpc`, `FargateComputeEnvironment`.
Step 4 is the first place this series runs into services where that isn't
true — `aws-cdk-lib/aws-glue` and `aws-cdk-lib/aws-athena` export **only**
generated L1s (`CfnDatabase`, `CfnTable`, `CfnWorkGroup`). The curated L2
for Glue lives in a separate, still-experimental package
(`@aws-cdk/aws-glue-alpha`) that this project doesn't depend on.

[Step 0](00-cdk-constructs-and-levels.md) explained why L2s exist: sane
defaults and a smaller surface area over a raw CloudFormation shape. That
argument doesn't stop applying just because AWS hasn't published one yet —
so `QueryCatalog` *is* this step's L2, in the same spirit as `DataLakeBucket`
(Step 1): three L1s (`CfnDatabase`, `CfnTable`, `CfnWorkGroup`) composed
behind one constructor that only asks its caller for what actually varies
(`sourceBucket`, `removalPolicy`), with the encryption, workgroup
enforcement, and delete-safety choices already made. The difference from
Step 1 is *why* — there, an L2 already existed and this project chose to
wrap it anyway for stronger defaults; here, wrapping L1s directly was the
only option at all.

## The Deliberate Absence: No Glue Crawler

The instinctive way to get a Glue table over an S3 prefix is a **Glue
Crawler**: point it at `processed/`, let it infer a schema, and it
maintains the table for you as new data shows up. This step doesn't use
one, and — unlike Step 3's EventBridge dead end — this isn't a wrong turn
corrected after the fact. It's ruled out for the same reason a crawler
would exist in the first place: **there is no fixed schema to infer.**

`process.py` turns a JSON array into one line per element, a single JSON
object into one line, and anything that isn't valid JSON into
`{"text": "..."}` lines — three different shapes, chosen per source object,
with no guarantee any two objects under `processed/` share a structure. A
crawler run against that would produce the same non-answer a human would:
"the rows are JSON, and that's as specific as it gets." Paying for a
crawler's own IAM role, its schedule (or its own trigger wiring), and its
CloudWatch Logs to arrive at that conclusion is a moving part with nothing
to show for it — the same shape of trade-off Step 3 hit with EventBridge's
`BatchJob` target, just decided *before* writing the code instead of after.

## The Table: One Column, and Presto Does the Rest

Instead of a crawler-inferred schema, `QueryCatalog`'s table declares
exactly one column:

```ts
storageDescriptor: {
  location: props.sourceBucket.s3UrlForObject('processed/'),
  inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
  outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
  serdeInfo: {
    serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
    parameters: { 'field.delim': '' },
  },
  columns: [{ name: 'line', type: 'string' }],
},
```

`LazySimpleSerDe` splits each row on `field.delim`. Setting it to ``
(a control character that can never appear inside a JSON Lines file) means
the delimiter never matches — every row comes back as exactly one field:
the entire line, untouched. Querying it reaches into that string with
Athena's underlying engine's own JSON functions:

```sql
SELECT
  json_extract_scalar(line, '$.text') AS text_value,
  json_extract_scalar(line, '$.bucket') AS bucket_value
FROM pipeline_data.processed
WHERE json_extract_scalar(line, '$.text') IS NOT NULL;
```

This isn't a workaround this project reached for reluctantly — it's the
honest counterpart to Step 3's own honesty about its output. A table with
concrete, typed columns would be *more* convenient to query, but it would
also be a claim about structure the data doesn't have. The
`json_extract_scalar` calls stay in every query instead of once in the
table definition — a deliberate trade-off, not the only defensible way to
model this, in exchange for never making a claim the data can't back up.

## No IAM Role: The Odd One Out

Every construct before this one has needed an IAM role built or granted
for it: `IngestFunction`'s and `ProcessingTrigger`'s function roles,
`ProcessingJob`'s `jobRole`. `QueryCatalog` grants none. Athena has no
service-side execution role of its own — a query runs as **whoever calls
`athena:StartQueryExecution`**, using their own IAM identity's own
permissions, not a role this construct could pre-authorize on their
behalf. `DataPipelineStack` correspondingly grants nothing new here.

The practical consequence for a real deployment: whoever is going to run
Athena queries against `pipeline_data.processed` needs, *separately from
this stack*, `glue:GetDatabase`/`glue:GetTable`, the four
`athena:*QueryExecution*` actions (or a managed policy that bundles them),
`s3:GetObject` on `processed/*`, and `s3:GetObject`/`s3:PutObject` on
`athena-results/*` — the workgroup's query-results prefix. That's a
deliberate scope boundary, not an oversight: granting query access is a
decision about *who*, made per person or role, not something a pipeline
construct should decide on anyone's behalf.

## The Workgroup: Encrypted Results, Enforced Settings

```ts
workGroupConfiguration: {
  enforceWorkGroupConfiguration: true,
  publishCloudWatchMetricsEnabled: true,
  resultConfiguration: {
    outputLocation: props.sourceBucket.s3UrlForObject('athena-results/'),
    encryptionConfiguration: { encryptionOption: 'SSE_S3' },
  },
},
```

`enforceWorkGroupConfiguration: true` makes the workgroup's settings
authoritative — a caller's own client-side configuration (a different
output location, no encryption) is overridden rather than merely
defaulted-from. Query results land under the same bucket's
`athena-results/` prefix rather than a new bucket: this step adds a schema
and a query surface, not new storage to operate.

`recursiveDeleteOption: true` is the one setting here that's purely about
this repo's own demo ergonomics (see `DataPipelineStack`'s
`demoRemovalPolicy` comment): without it, CloudFormation refuses to delete
a workgroup that has ever run a query, and `cdk destroy` would fail on a
stack that was actually used for its intended purpose.

## cdk-nag's Findings for Step 4

None. `AwsSolutionsChecks` reports zero new violations for this step — the
Glue/Athena rules cdk-nag ships (`GlueJobBookmarkEncrypted`,
`GlueEncryptedCloudWatchLogs`) only apply to `AWS::Glue::Job`, and this
step never creates one. That's a direct consequence of the "no crawler, no
IAM role" shape above, not a gap in cdk-nag's coverage: there's simply
less here for a rule pack aimed at compute and access-control mistakes to
have an opinion about.

## What's Next

Step 4 completes the pipeline the README's roadmap set out to build:
**S3 → Lambda → AWS Batch → Athena**. From here, the series' remaining
room to grow is less "add the next service" and more "revisit an earlier
step with something this one surfaced" — for example, partitioning
`processed/` (by date, or by source) once there's enough data under it for
a full-table scan to actually cost something, or tightening the query-user
IAM policy this article left as an exercise into its own reviewable
construct.
