import { App } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataPipelineStack } from '../lib/data-pipeline-stack';
import * as cdkJson from '../cdk.json';

describe('DataPipelineStack (Step 1: S3)', () => {
  // Feature flags in cdk.json are only applied by the `cdk` CLI, never by a
  // plain `new App()` — Jest has to load them explicitly or the stack
  // behaves differently under test than it does under `cdk synth`/`deploy`.
  const app = new App({ context: cdkJson.context });
  const stack = new DataPipelineStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  test('creates exactly two buckets: data + access logs', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  test('the data bucket is encrypted, versioned, and blocks public access', () => {
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
      LoggingConfiguration: Match.objectLike({
        LogFilePrefix: 'data-bucket-access-logs/',
      }),
    }));
  });

  test('bucket policies require TLS', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    }));
  });

  // cdk-nag 3.x registers as a CDK Validations plugin rather than an Aspect,
  // so `validateScope()` — its own documented test entry point — is used
  // directly instead of running a full `cdk synth`.
  test('passes the AWS Solutions (cdk-nag) rule pack with no violations', () => {
    const report = new AwsSolutionsChecks().validateScope(stack);
    if (!report.success) {
      // Fail with the actual violations printed, not just "false !== true".
      throw new Error(
        `cdk-nag AwsSolutions violations:\n${JSON.stringify(report.violations, null, 2)}`,
      );
    }
    expect(report.success).toBe(true);
  });
});
