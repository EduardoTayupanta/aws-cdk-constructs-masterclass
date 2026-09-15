import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
  ObjectOwnership,
  StorageClass,
} from 'aws-cdk-lib/aws-s3';

export interface DataLakeBucketProps {
  /**
   * What happens to the bucket (and its access-logs bucket) when the stack
   * is destroyed.
   *
   * Defaults to `RETAIN`, matching production best practice: a data lake
   * bucket should never disappear because someone ran `cdk destroy`. Pass
   * `DESTROY` explicitly at the call site for throwaway/demo stacks — see
   * `autoDeleteObjects` below.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to delete all objects in the bucket automatically when the
   * bucket itself is destroyed. Only meaningful (and only takes effect)
   * when `removalPolicy` is `DESTROY` — CDK will refuse to delete a
   * non-empty bucket otherwise.
   *
   * @default false
   */
  readonly autoDeleteObjects?: boolean;
}

/**
 * A production-shaped S3 bucket for a data lake / pipeline stage, built as
 * an L2 composition: encryption, TLS enforcement, public-access blocking,
 * an intermediate-storage lifecycle rule, and server access logging are
 * all wired in by default instead of left for every caller to remember.
 *
 * This is what an "L3-flavored" building block looks like even at a small
 * scale — a couple of L2 constructs (two `Bucket`s) composed behind one
 * intent-revealing API (`new DataLakeBucket(...)`).
 */
export class DataLakeBucket extends Construct {
  /** The bucket callers read from and write pipeline data to. */
  public readonly bucket: Bucket;

  /** Destination bucket for the data bucket's server access logs. */
  public readonly accessLogsBucket: Bucket;

  constructor(scope: Construct, id: string, props: DataLakeBucketProps = {}) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const autoDeleteObjects = props.autoDeleteObjects ?? false;

    this.accessLogsBucket = new Bucket(this, 'AccessLogsBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy,
      autoDeleteObjects,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          expiration: Duration.days(365),
        },
      ],
    });

    this.bucket = new Bucket(this, 'Bucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy,
      autoDeleteObjects,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'data-bucket-access-logs/',
      lifecycleRules: [
        {
          id: 'transition-to-infrequent-access',
          transitions: [
            {
              storageClass: StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
    });

    // Note: the access-logs bucket itself is not given a `serverAccessLogsBucket`
    // — cdk-nag's AwsSolutions-S1 rule specifically recognizes a bucket that is
    // already the *destination* of another bucket's access logs and treats it
    // as compliant, so no suppression is needed here.
  }
}
