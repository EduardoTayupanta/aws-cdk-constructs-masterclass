import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { DataLakeBucket } from './constructs/data-lake-bucket';

/**
 * The single, growing stack for the masterclass pipeline:
 *
 *   S3  ->  Lambda  ->  AWS Batch (Python)  ->  Athena
 *
 * Each step of the series adds the next construct to this stack instead of
 * starting a new, disconnected demo. This is Step 1: the S3 foundation.
 */
export class DataPipelineStack extends Stack {
  /** Raw data landing zone for the pipeline. */
  public readonly rawDataBucket: DataLakeBucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.rawDataBucket = new DataLakeBucket(this, 'RawDataBucket', {
      // Demo-only choice: destroy the bucket (and its contents) on
      // `cdk destroy` so this masterclass stack is easy to tear down while
      // following along. Production pipelines should keep the construct's
      // default of RemovalPolicy.RETAIN.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new CfnOutput(this, 'RawDataBucketName', {
      value: this.rawDataBucket.bucket.bucketName,
      description:
        'S3 bucket that receives raw pipeline data (Step 1 of the masterclass).',
    });
  }
}
