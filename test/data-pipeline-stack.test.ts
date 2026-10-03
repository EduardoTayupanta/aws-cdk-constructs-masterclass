import { App } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataPipelineStack } from '../lib/data-pipeline-stack';
import * as cdkJson from '../cdk.json';

describe('DataPipelineStack (Steps 1-4: S3 + Lambda + Batch + Athena)', () => {
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

  test('the raw data bucket notifies the ingest function (and only that function) for objects under raw/', () => {
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
            // Pins the ARN to IngestFunction specifically — without this, a
            // swap between IngestFunction and ProcessingTrigger's wiring
            // below would pass just as easily, since both configurations
            // otherwise look structurally identical.
            LambdaFunctionArn: Match.objectLike({
              'Fn::GetAtt': [Match.stringLikeRegexp('^IngestFunction'), 'Arn'],
            }),
          }),
        ]),
      }),
    }));
  });

  test('the raw data bucket notifies the processing trigger (and only that function) for objects under manifests/', () => {
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
            LambdaFunctionArn: Match.objectLike({
              'Fn::GetAtt': [Match.stringLikeRegexp('^ProcessingTrigger'), 'Arn'],
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

  test('the Glue table points at processed/ and reads each line as one string column', () => {
    template.hasResourceProperties('AWS::Glue::Table', Match.objectLike({
      DatabaseName: 'pipeline_data',
      TableInput: Match.objectLike({
        Name: 'processed',
        StorageDescriptor: Match.objectLike({
          Location: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('/processed/$')]),
            ]),
          }),
          Columns: [Match.objectLike({ Name: 'line', Type: 'string' })],
        }),
      }),
    }));
  });

  test('the Athena workgroup enforces its configuration and encrypts query results', () => {
    template.hasResourceProperties('AWS::Athena::WorkGroup', Match.objectLike({
      RecursiveDeleteOption: true,
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        ResultConfiguration: Match.objectLike({
          EncryptionConfiguration: { EncryptionOption: 'SSE_S3' },
        }),
      }),
    }));
  });

  test('creates exactly one Glue database, one Glue table, and one Athena workgroup', () => {
    template.resourceCountIs('AWS::Glue::Database', 1);
    template.resourceCountIs('AWS::Glue::Table', 1);
    template.resourceCountIs('AWS::Athena::WorkGroup', 1);
  });

  test('the processing job\'s VPC is single-AZ (one subnet, no HA benefit for a one-at-a-time job)', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 1);
  });

  test('the pipeline has exactly one alerts topic, encrypted with its own KMS key', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', Match.objectLike({
      KmsMasterKeyId: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^PipelineAlertsKey')]) }),
    }));
  });

  test('the alerts topic policy denies publishing over an insecure transport', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 'sns:Publish',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    }));
  });

  test('both the ingest function and the processing trigger route async-invoke failures to the alerts topic', () => {
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 2);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', Match.objectLike({
      FunctionName: Match.objectLike({ Ref: Match.stringLikeRegexp('^IngestFunction') }),
      DestinationConfig: Match.objectLike({
        OnFailure: Match.objectLike({ Destination: Match.objectLike({ Ref: Match.stringLikeRegexp('^PipelineAlerts') }) }),
      }),
    }));
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', Match.objectLike({
      FunctionName: Match.objectLike({ Ref: Match.stringLikeRegexp('^ProcessingTrigger') }),
      DestinationConfig: Match.objectLike({
        OnFailure: Match.objectLike({ Destination: Match.objectLike({ Ref: Match.stringLikeRegexp('^PipelineAlerts') }) }),
      }),
    }));
  });

  test('an EventBridge rule routes FAILED Batch job state changes on this pipeline\'s job queue to the alerts topic', () => {
    template.hasResourceProperties('AWS::Events::Rule', Match.objectLike({
      EventPattern: Match.objectLike({
        source: ['aws.batch'],
        'detail-type': ['Batch Job State Change'],
        detail: Match.objectLike({
          status: ['FAILED'],
          jobQueue: Match.arrayWith([
            Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^ProcessingJobJobQueue')]) }),
          ]),
        }),
      }),
      Targets: Match.arrayWith([
        Match.objectLike({ Arn: Match.objectLike({ Ref: Match.stringLikeRegexp('^PipelineAlerts') }) }),
      ]),
    }));
  });

  test('the alerts topic and its KMS key deny EventBridge principals from any rule other than the pipeline\'s own', () => {
    // Regression guard for the confused-deputy fix: aws-events-targets'
    // SnsTopic target grants events.amazonaws.com publish (and, via the
    // topic's masterKey, kms:Decrypt/kms:GenerateDataKey*) with no
    // aws:SourceArn condition of its own — these two explicit Denies are
    // the only thing narrowing that grant to this pipeline's own rule.
    // Neither cdk-nag nor any other test in this file would catch either
    // Deny being silently dropped or its condition being loosened.
    template.hasResourceProperties('AWS::SNS::TopicPolicy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyPublishFromOtherEventBridgeRules',
            Effect: 'Deny',
            Principal: { Service: 'events.amazonaws.com' },
            Action: 'sns:Publish',
            Condition: {
              StringNotEquals: {
                'aws:SourceArn': Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp(':rule/ProcessingJobFailureRule$')]),
                  ]),
                }),
              },
            },
          }),
        ]),
      }),
    }));

    template.hasResourceProperties('AWS::KMS::Key', Match.objectLike({
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyKeyUseFromOtherEventBridgeRules',
            Effect: 'Deny',
            Principal: { Service: 'events.amazonaws.com' },
            Action: ['kms:Decrypt', 'kms:GenerateDataKey*'],
            Condition: {
              StringNotEquals: {
                'aws:SourceArn': Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp(':rule/ProcessingJobFailureRule$')]),
                  ]),
                }),
              },
            },
          }),
        ]),
      }),
    }));
  });

  test('exposes the processing job queue and the bucket key-prefix convention as outputs', () => {
    template.hasOutput('ProcessingJobQueueArn', Match.objectLike({
      Value: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^ProcessingJobJobQueue')]) }),
    }));
    template.hasOutput('BucketKeyPrefixConvention', Match.objectLike({
      Value: Match.stringLikeRegexp('raw/.*manifests/.*processed/'),
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
