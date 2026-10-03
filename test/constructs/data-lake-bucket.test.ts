import { App, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DataLakeBucket } from '../../lib/constructs/data-lake-bucket';
import * as cdkJson from '../../cdk.json';

// Feature flags in cdk.json are only applied by the `cdk` CLI, never by a
// plain `new App()` — loaded explicitly here so a standalone construct test
// behaves the same as it does under the real stack (e.g. the S3 feature
// flag that switches server-access-logs wiring from ACLs to bucket policy).
function newTestStack(): Stack {
  return new Stack(new App({ context: cdkJson.context }), 'TestStack');
}

describe('DataLakeBucket', () => {
  describe('with default props', () => {
    const stack = newTestStack();
    new DataLakeBucket(stack, 'DataLakeBucket');
    const template = Template.fromStack(stack);

    test('creates exactly two buckets: data + access logs', () => {
      template.resourceCountIs('AWS::S3::Bucket', 2);
    });

    test('the data bucket is encrypted, versioned, blocks public access, and logs to the access-logs bucket', () => {
      template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'AES256' }),
            }),
          ]),
        }),
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        LoggingConfiguration: Match.objectLike({
          LogFilePrefix: 'data-bucket-access-logs/',
        }),
      }));
    });

    test('the data bucket transitions to Infrequent Access after 30 days', () => {
      template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: 'Enabled',
              Transitions: Match.arrayWith([
                Match.objectLike({ StorageClass: 'STANDARD_IA', TransitionInDays: 30 }),
              ]),
            }),
          ]),
        }),
      }));
    });

    test('the access-logs bucket blocks public access and expires objects after 365 days', () => {
      template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({ Status: 'Enabled', ExpirationInDays: 365 }),
          ]),
        }),
      }));
    });

    test('both bucket policies require TLS', () => {
      template.resourcePropertiesCountIs('AWS::S3::BucketPolicy', Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        }),
      }), 2);
    });

    test('defaults to RETAIN for both buckets and provisions no auto-delete-objects custom resource', () => {
      template.resourcePropertiesCountIs('AWS::S3::Bucket', {}, 2);
      template.hasResource('AWS::S3::Bucket', Match.objectLike({
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      }));
      template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    });
  });

  test('an explicit DESTROY removalPolicy with autoDeleteObjects overrides the RETAIN default', () => {
    const stack = newTestStack();
    new DataLakeBucket(stack, 'DataLakeBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::S3::Bucket', Match.objectLike({
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    }));
    // One per bucket (data + access logs).
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 2);
  });
});
