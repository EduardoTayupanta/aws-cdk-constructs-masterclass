import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib/core';
import { EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { DataLakeBucket } from './constructs/data-lake-bucket';
import { IngestFunction } from './constructs/ingest-function';
import { ProcessingJob } from './constructs/processing-job';
import { ProcessingTrigger } from './constructs/processing-trigger';

/**
 * The single, growing stack for the masterclass pipeline:
 *
 *   S3  ->  Lambda  ->  AWS Batch (Python)  ->  Athena
 *
 * Each step of the series adds the next construct to this stack instead of
 * starting a new, disconnected demo. This is Step 3: AWS Batch.
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

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Demo-only choice, used for every construct in this stack: destroy
    // resources (and their contents) on `cdk destroy` so this masterclass
    // stack is easy to tear down while following along. Production
    // pipelines should keep each construct's default of RETAIN.
    const demoRemovalPolicy = RemovalPolicy.DESTROY;

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
          'Included by Bucket.grantRead() alongside s3:GetObject*; the statement is still scoped to the manifests/* and raw/* prefixes below, not the whole bucket.',
      },
      {
        id: 'AwsSolutions-IAM5[Action::s3:GetObject*]',
        reason: 'Bucket.grantRead()\'s object-read action, scoped to the manifests/* and raw/* prefixes below.',
      },
      {
        id: 'AwsSolutions-IAM5[Action::s3:List*]',
        reason:
          'Included by Bucket.grantRead() alongside s3:GetObject*; the statement is still scoped to the manifests/* and raw/* prefixes below, not the whole bucket.',
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
  }
}
