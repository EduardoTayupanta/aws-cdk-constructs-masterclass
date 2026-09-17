import { App } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataPipelineStack } from '../lib/data-pipeline-stack';
import * as cdkJson from '../cdk.json';

describe('DataPipelineStack (Steps 1-3: S3 + Lambda + Batch)', () => {
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

  test('the ingest function is packaged as a container image with tracing on', () => {
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      PackageType: 'Image',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    }));
  });

  test('the ingest function is only granted scoped write access to manifests/*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('/manifests/\\*$')]),
              ]),
            }),
          }),
        ]),
      }),
    }));
  });

  test('the raw data bucket notifies the ingest function for objects under raw/', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', Match.objectLike({
      NotificationConfiguration: Match.objectLike({
        LambdaFunctionConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: Match.objectLike({
              Key: {
                FilterRules: Match.arrayWith([
                  Match.objectLike({ Name: 'prefix', Value: 'raw/' }),
                ]),
              },
            }),
          }),
        ]),
      }),
    }));
  });

  test('the raw data bucket notifies the processing trigger for objects under manifests/', () => {
    template.hasResourceProperties('Custom::S3BucketNotifications', Match.objectLike({
      NotificationConfiguration: Match.objectLike({
        LambdaFunctionConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: Match.objectLike({
              Key: {
                FilterRules: Match.arrayWith([
                  Match.objectLike({ Name: 'prefix', Value: 'manifests/' }),
                ]),
              },
            }),
          }),
        ]),
      }),
    }));
  });

  test('the processing job runs on Fargate with no public IP and a bounded timeout', () => {
    template.hasResourceProperties('AWS::Batch::JobDefinition', Match.objectLike({
      PlatformCapabilities: ['FARGATE'],
      ContainerProperties: Match.objectLike({
        NetworkConfiguration: { AssignPublicIp: 'DISABLED' },
      }),
      Timeout: { AttemptDurationSeconds: 300 },
    }));
  });

  test('the processing job\'s compute environment, queue, and job definition are wired together', () => {
    template.resourceCountIs('AWS::Batch::ComputeEnvironment', 1);
    template.resourceCountIs('AWS::Batch::JobQueue', 1);
    template.resourceCountIs('AWS::Batch::JobDefinition', 1);
  });

  test('the processing job\'s VPC has no NAT Gateway (isolated subnets only)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('the processing job\'s task role is only granted scoped access to manifests/*, raw/*, and processed/*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:GetObject*']),
            Resource: Match.arrayWith([
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp('/manifests/\\*$')]),
                ]),
              }),
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp('/raw/\\*$')]),
                ]),
              }),
            ]),
          }),
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('/processed/\\*$')]),
              ]),
            }),
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
