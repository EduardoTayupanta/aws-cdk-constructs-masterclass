import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib/core';
import { EventType } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { DataLakeBucket } from './constructs/data-lake-bucket';
import { IngestFunction } from './constructs/ingest-function';

/**
 * The single, growing stack for the masterclass pipeline:
 *
 *   S3  ->  Lambda  ->  AWS Batch (Python)  ->  Athena
 *
 * Each step of the series adds the next construct to this stack instead of
 * starting a new, disconnected demo. This is Step 2: Lambda.
 */
export class DataPipelineStack extends Stack {
  /** Raw data landing zone for the pipeline. */
  public readonly rawDataBucket: DataLakeBucket;

  /** Reacts to new objects under `raw/` and writes a manifest for them. */
  public readonly ingestFunction: IngestFunction;

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
