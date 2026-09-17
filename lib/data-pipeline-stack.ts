import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib/core';
import { EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { SnsDestination } from 'aws-cdk-lib/aws-lambda-destinations';
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { DataLakeBucket } from './constructs/data-lake-bucket';
import { IngestFunction } from './constructs/ingest-function';
import { ProcessingJob } from './constructs/processing-job';
import { ProcessingTrigger } from './constructs/processing-trigger';
import { QueryCatalog } from './constructs/query-catalog';

/**
 * The single, growing stack for the masterclass pipeline:
 *
 *   S3  ->  Lambda  ->  AWS Batch (Python)  ->  Athena
 *
 * Each step of the series adds the next construct to this stack instead of
 * starting a new, disconnected demo. This is Step 4: Athena.
 */
export class DataPipelineStack extends Stack {
  /** Raw data landing zone for the pipeline. */
  public readonly rawDataBucket: DataLakeBucket;

  /** Reacts to new objects under `raw/` and writes a manifest for them. */
  public readonly ingestFunction: IngestFunction;

  /** Turns one raw object into a `processed/` JSON Lines object. */
  public readonly processingJob: ProcessingJob;

  /** Reacts to new manifests and submits a `processingJob` job per one. */
  public readonly processingTrigger: ProcessingTrigger;

  /** Glue/Athena schema over `processingJob`'s `processed/` output. */
  public readonly queryCatalog: QueryCatalog;

  /**
   * Shared failure-alert topic for the whole pipeline: both Lambdas'
   * async-invoke failures and Batch job failures publish here. It's a
   * stack-level resource, not owned by any one construct, because failure
   * reporting is a cross-cutting concern across every step of the
   * pipeline, not a responsibility of any single one of them.
   */
  public readonly alertsTopic: Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Demo-only choice, used for every construct in this stack: destroy
    // resources (and their contents) on `cdk destroy` so this masterclass
    // stack is easy to tear down while following along. Production
    // pipelines should keep each construct's default of RETAIN.
    const demoRemovalPolicy = RemovalPolicy.DESTROY;

    // AwsSolutions-SNS2: encrypt the topic at rest. A customer-managed key
    // (rather than the `alias/aws/sns` AWS-managed key) is what makes that
    // encryption's IAM grants resource-scoped below — referencing the
    // managed key by alias leaves CDK unable to resolve its concrete key
    // ID at synth time, so it falls back to a `key/*` wildcard resource in
    // the publishers' policies instead of this key's own ARN.
    const alertsTopicKey = new Key(this, 'PipelineAlertsKey', {
      enableKeyRotation: true,
      removalPolicy: demoRemovalPolicy,
    });

    this.alertsTopic = new Topic(this, 'PipelineAlerts', {
      masterKey: alertsTopicKey,
    });

    // AwsSolutions-SNS3: require TLS for anything publishing to the topic
    // (EventBridge, and the Lambdas' async-invoke failure destination) —
    // same deny-if-insecure pattern as the bucket policy above, applied to
    // the topic's resource policy instead.
    this.alertsTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyInsecureTransport',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [this.alertsTopic.topicArn],
        conditions: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    );

    this.rawDataBucket = new DataLakeBucket(this, 'RawDataBucket', {
      removalPolicy: demoRemovalPolicy,
      autoDeleteObjects: true,
    });

    new CfnOutput(this, 'RawDataBucketName', {
      value: this.rawDataBucket.bucket.bucketName,
      description:
        'S3 bucket that receives raw pipeline data (Step 1 of the masterclass).',
    });

    this.ingestFunction = new IngestFunction(this, 'IngestFunction', {
      removalPolicy: demoRemovalPolicy,
    });

    // S3 invokes this function asynchronously — without an `onFailure`
    // destination, a failed invocation (after Lambda's own retries) simply
    // vanishes with no signal anywhere. Routing it to the shared alerts
    // topic is the minimum needed to know the pipeline dropped an object.
    this.ingestFunction.fn.configureAsyncInvoke({
      onFailure: new SnsDestination(this.alertsTopic),
    });

    // Publishing an encrypted SNS message requires encrypting it with the
    // topic's KMS key first — `SnsDestination`'s grant therefore includes
    // `kms:GenerateDataKey*` (via `Key.grantEncrypt()`), which, like
    // S3's `Abort*` and X-Ray's tracing actions elsewhere in this stack,
    // has no non-wildcard form; it's the exact action name KMS defines,
    // not a broad grant this construct chose. The resource side is
    // properly scoped to PipelineAlertsKey's own ARN, not key/*.
    Validations.of(this.ingestFunction.fn).acknowledge({
      id: 'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]',
      reason:
        'Granted by the onFailure SnsDestination so this function can publish to the encrypted PipelineAlerts topic; kms:GenerateDataKey* has no non-wildcard form and is scoped to PipelineAlertsKey\'s own ARN, not key/*.',
    });

    // Least privilege: the function never reads pipeline data, so it's only
    // granted write access to the one prefix it actually writes to.
    this.rawDataBucket.bucket.grantPut(this.ingestFunction.fn, 'manifests/*');

    // grantPut()'s statement contains two things cdk-nag's blanket
    // wildcard check (AwsSolutions-IAM5) can't tell apart from a careless
    // wildcard: `s3:Abort*` (needed to abort a multipart upload the
    // function itself started) and the `manifests/*` prefix scope, which
    // is the whole point of passing a key pattern to grantPut() in the
    // first place — the function still can't touch anything outside it.
    Validations.of(this.ingestFunction.fn).acknowledge(
      {
        id: 'AwsSolutions-IAM5[Action::s3:Abort*]',
        reason:
          'Included by Bucket.grantPut() so the function can abort a multipart upload it started itself; the statement is already scoped to the manifests/* prefix, not the whole bucket.',
      },
      {
        id: 'AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/manifests/*]',
        reason:
          'This is a deliberate S3 prefix scope (manifests/*) from Bucket.grantPut()\'s keyPattern argument, not an unscoped wildcard — the function can never write outside that one prefix.',
      },
    );

    this.rawDataBucket.bucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(this.ingestFunction.fn),
      { prefix: 'raw/' },
    );

    this.processingJob = new ProcessingJob(this, 'ProcessingJob', {
      removalPolicy: demoRemovalPolicy,
    });

    // Least privilege for the container's own task role: it reads the
    // manifest and the raw object the manifest points to, and writes only
    // to processed/ — never anything outside those three prefixes.
    this.rawDataBucket.bucket.grantRead(this.processingJob.jobRole, 'manifests/*');
    this.rawDataBucket.bucket.grantRead(this.processingJob.jobRole, 'raw/*');
    this.rawDataBucket.bucket.grantPut(this.processingJob.jobRole, 'processed/*');

    this.processingTrigger = new ProcessingTrigger(this, 'ProcessingTrigger', {
      jobQueue: this.processingJob.jobQueue,
      jobDefinition: this.processingJob.jobDefinition,
      removalPolicy: demoRemovalPolicy,
    });

    // Same async-invoke failure gap as IngestFunction above, for the same
    // reason: S3 invokes this one asynchronously too.
    this.processingTrigger.fn.configureAsyncInvoke({
      onFailure: new SnsDestination(this.alertsTopic),
    });

    // Same KMS grant shape as IngestFunction above, for the same reason:
    // publishing to the encrypted PipelineAlerts topic requires
    // kms:GenerateDataKey*, which has no non-wildcard form.
    Validations.of(this.processingTrigger.fn).acknowledge({
      id: 'AwsSolutions-IAM5[Action::kms:GenerateDataKey*]',
      reason:
        'Granted by the onFailure SnsDestination so this function can publish to the encrypted PipelineAlerts topic; kms:GenerateDataKey* has no non-wildcard form and is scoped to PipelineAlertsKey\'s own ARN, not key/*.',
    });

    // Batch retries a failed job (see ProcessingJob's `retryAttempts: 2`)
    // before giving up — this rule is what surfaces that final failure.
    // EventBridge's default bus receives one `Batch Job State Change`
    // event per job status transition; filtering on `jobQueue` scopes this
    // to jobs from *this* pipeline's queue specifically, since the default
    // bus is account-wide and could carry events from other Batch queues.
    new Rule(this, 'ProcessingJobFailureRule', {
      eventPattern: {
        source: ['aws.batch'],
        detailType: ['Batch Job State Change'],
        detail: {
          status: ['FAILED'],
          jobQueue: [this.processingJob.jobQueue.jobQueueArn],
        },
      },
      targets: [new SnsTopic(this.alertsTopic)],
    });

    this.rawDataBucket.bucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(this.processingTrigger.fn),
      { prefix: 'manifests/' },
    );

    // Same cdk-nag wildcard shape as IngestFunction's manifests/* grant
    // (Step 2): grantRead/grantPut's statements bundle in a handful of
    // actions (s3:GetObject*, s3:GetBucket*, s3:List*, s3:Abort*) that
    // AwsSolutions-IAM5 can't tell apart from an unscoped wildcard —
    // they're already confined to the three prefix-scoped resource ARNs
    // acknowledged below, one per grant.
    Validations.of(this.processingJob.jobRole).acknowledge(
      {
        id: 'AwsSolutions-IAM5[Action::s3:GetBucket*]',
        reason:
          'Included by Bucket.grantRead() alongside s3:GetObject*. Unlike GetObject*, this action operates on the bucket resource itself, not on individual keys, so it is *not* scoped by the manifests/*, raw/* resource ARNs below — it applies to the whole bucket ARN. That only lets the role read bucket-level metadata (e.g. GetBucketLocation), not object contents, which stays confined to those two prefixes.',
      },
      {
        id: 'AwsSolutions-IAM5[Action::s3:GetObject*]',
        reason: 'Bucket.grantRead()\'s object-read action, scoped to the manifests/* and raw/* prefixes below.',
      },
      {
        id: 'AwsSolutions-IAM5[Action::s3:List*]',
        reason:
          'Included by Bucket.grantRead() alongside s3:GetObject*. Like GetBucket* above, s3:ListBucket is a bucket-level action with no per-key granularity, so it applies to the whole bucket ARN rather than the manifests/*, raw/* resources below — it lets the role enumerate object *key names* bucket-wide, not read object content, which stays confined to those two prefixes via GetObject*.',
      },
      {
        id: 'AwsSolutions-IAM5[Action::s3:Abort*]',
        reason:
          'Included by Bucket.grantPut() so the job can abort a multipart upload it started itself; the statement is already scoped to the processed/* prefix below.',
      },
      {
        id: `AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/manifests/*]`,
        reason: 'Deliberate S3 prefix scope from grantRead(jobRole, \'manifests/*\') — the job can never read outside it.',
      },
      {
        id: `AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/raw/*]`,
        reason: 'Deliberate S3 prefix scope from grantRead(jobRole, \'raw/*\') — the job can never read outside it.',
      },
      {
        id: `AwsSolutions-IAM5[Resource::<RawDataBucket0AE59F17.Arn>/processed/*]`,
        reason: 'Deliberate S3 prefix scope from grantPut(jobRole, \'processed/*\') — the job can never write outside it.',
      },
    );

    // addEventNotification() provisions a CDK-managed singleton custom
    // resource (`BucketNotificationsHandler...`) to configure the S3 event
    // notification. Its role attaches the same AWS-managed base execution
    // policy as our own IngestFunction (see that construct for why that's
    // acceptable) — but it's aws-cdk-lib's own generated construct, not
    // application code, so it's acknowledged here at the stack level
    // rather than inside a construct that doesn't actually own it.
    Validations.of(this).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      reason:
        'AWSLambdaBasicExecutionRole only grants CloudWatch Logs write permissions (CreateLogGroup/CreateLogStream/PutLogEvents). It is attached to IngestFunction\'s role (which already logs to an explicit, retention-controlled LogGroup) and to the CDK-generated BucketNotificationsHandler custom resource used to wire up S3 event notifications. Replacing it with a hand-written inline policy would grant the same three actions without reducing risk.',
    });

    this.queryCatalog = new QueryCatalog(this, 'QueryCatalog', {
      sourceBucket: this.rawDataBucket.bucket,
      removalPolicy: demoRemovalPolicy,
    });

    // Unlike every construct before it, QueryCatalog grants no IAM
    // permissions here: Athena queries execute as whoever calls
    // athena:StartQueryExecution, not as a role this construct owns. See
    // docs/05-athena-glue.md for what that implies for a real query user.
    new CfnOutput(this, 'GlueTableName', {
      value: `${this.queryCatalog.databaseName}.${this.queryCatalog.tableName}`,
      description: 'Glue Data Catalog table over processed/, queryable from Athena (Step 4).',
    });

    new CfnOutput(this, 'AthenaWorkGroupName', {
      value: this.queryCatalog.workGroup.name,
      description: 'Athena workgroup to run queries against GlueTableName in.',
    });

    new CfnOutput(this, 'ProcessingJobQueueArn', {
      value: this.processingJob.jobQueue.jobQueueArn,
      description:
        'AWS Batch job queue processing jobs run on — useful for inspecting/aborting jobs via the Batch console or CLI (Step 3).',
    });

    new CfnOutput(this, 'BucketKeyPrefixConvention', {
      value:
        'raw/<key> (uploaded by you, Step 1) -> manifests/<key> (written by IngestFunction, Step 2) -> processed/<key> (written by ProcessingJob, Step 3, queried via GlueTableName).',
      description: 'Key-prefix convention inside RawDataBucketName that drives the whole pipeline end to end.',
    });
  }
}
