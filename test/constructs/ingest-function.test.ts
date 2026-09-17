import { App, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IngestFunction } from '../../lib/constructs/ingest-function';
import * as cdkJson from '../../cdk.json';

// See data-lake-bucket.test.ts for why cdk.json's feature flags are loaded
// explicitly instead of using a bare `new App()`.
function newTestStack(): Stack {
  return new Stack(new App({ context: cdkJson.context }), 'TestStack');
}

describe('IngestFunction', () => {
  test('is packaged as an ARM64 container image with tracing on and a 30s/256MB budget', () => {
    const stack = newTestStack();
    new IngestFunction(stack, 'IngestFunction');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      PackageType: 'Image',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      MemorySize: 256,
      Timeout: 30,
    }));
  });

  test('defaults to a one-month log retention and a RETAIN log group', () => {
    const stack = newTestStack();
    new IngestFunction(stack, 'IngestFunction');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', Match.objectLike({ RetentionInDays: 30 }));
    template.hasResource('AWS::Logs::LogGroup', Match.objectLike({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    }));
  });

  test('an explicit DESTROY removalPolicy overrides the log group\'s RETAIN default', () => {
    const stack = newTestStack();
    new IngestFunction(stack, 'IngestFunction', { removalPolicy: RemovalPolicy.DESTROY });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::Logs::LogGroup', Match.objectLike({
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    }));
  });

  test('grants no IAM permissions of its own beyond X-Ray tracing and the auto-created execution role', () => {
    // IngestFunction only wires the runtime knobs (image, arch, tracing,
    // memory/timeout, log group). The one policy that does exist is the
    // X-Ray tracing grant Tracing.ACTIVE adds automatically — every other
    // grant (S3 write, KMS, async-invoke destination) is added by the
    // caller (see DataPipelineStack), not by this construct itself.
    const stack = newTestStack();
    new IngestFunction(stack, 'IngestFunction');
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 1);
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Action: Match.arrayWith(['xray:PutTraceSegments']),
            Resource: '*',
          }),
        ],
      }),
    }));
    template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Action: Match.arrayWith(['xray:PutTelemetryRecords']),
            Resource: '*',
          }),
        ],
      }),
    }));
  });
});
