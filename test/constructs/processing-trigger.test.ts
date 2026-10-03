import { App, RemovalPolicy, Size, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import {
  EcsFargateContainerDefinition,
  EcsJobDefinition,
  FargateComputeEnvironment,
  JobQueue,
} from 'aws-cdk-lib/aws-batch';
import { ProcessingTrigger } from '../../lib/constructs/processing-trigger';
import * as cdkJson from '../../cdk.json';

// See data-lake-bucket.test.ts for why cdk.json's feature flags are loaded
// explicitly instead of using a bare `new App()`.
function newTestStack(): Stack {
  return new Stack(new App({ context: cdkJson.context }), 'TestStack');
}

// ProcessingTrigger only needs a JobQueue and an EcsJobDefinition to submit
// against — small local fixtures, standing in for ProcessingJob's real
// (VPC-backed) ones, are enough to exercise this construct alone.
function buildBatchFixtures(stack: Stack) {
  // restrictDefaultSecurityGroup: false keeps this throwaway fixture from
  // pulling in its own custom-resource Lambda (cdk.json's
  // @aws-cdk/aws-ec2:restrictDefaultSecurityGroup flag) — noise that has
  // nothing to do with ProcessingTrigger, the thing under test.
  const vpc = new Vpc(stack, 'FixtureVpc', {
    maxAzs: 1,
    natGateways: 0,
    restrictDefaultSecurityGroup: false,
  });
  const computeEnvironment = new FargateComputeEnvironment(stack, 'FixtureComputeEnv', { vpc });
  const jobQueue = new JobQueue(stack, 'FixtureQueue', {
    computeEnvironments: [{ computeEnvironment, order: 1 }],
  });
  const container = new EcsFargateContainerDefinition(stack, 'FixtureContainer', {
    image: ContainerImage.fromRegistry('busybox'),
    cpu: 0.25,
    memory: Size.mebibytes(512),
  });
  const jobDefinition = new EcsJobDefinition(stack, 'FixtureJobDefinition', { container });
  return { jobQueue, jobDefinition };
}

describe('ProcessingTrigger', () => {
  test('is packaged as a plain Zip function (no PackageType) with tracing on and a 10s/128MB budget', () => {
    const stack = newTestStack();
    const { jobQueue, jobDefinition } = buildBatchFixtures(stack);
    new ProcessingTrigger(stack, 'ProcessingTrigger', { jobQueue, jobDefinition });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      PackageType: Match.absent(),
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      MemorySize: 128,
      Timeout: 10,
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          JOB_QUEUE_ARN: Match.anyValue(),
          JOB_DEFINITION_ARN: Match.anyValue(),
        }),
      }),
    }));
  });

  test('is granted batch:SubmitJob scoped to exactly its own job queue and job definition, nothing else', () => {
    const stack = newTestStack();
    const { jobQueue, jobDefinition } = buildBatchFixtures(stack);
    new ProcessingTrigger(stack, 'ProcessingTrigger', { jobQueue, jobDefinition });
    const template = Template.fromStack(stack);

    // Two separate arrayWith checks, not one array of two patterns: the
    // grant's Resource order isn't a contract this test should pin down.
    template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'batch:SubmitJob',
            Effect: 'Allow',
            Resource: Match.arrayWith([{ Ref: Match.stringLikeRegexp('^FixtureJobDefinition') }]),
          }),
        ]),
      }),
    }));
    template.hasResourceProperties('AWS::IAM::Policy', Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'batch:SubmitJob',
            Effect: 'Allow',
            Resource: Match.arrayWith([
              Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^FixtureQueue')]) }),
            ]),
          }),
        ]),
      }),
    }));

    // Never touches S3 — the split that keeps this role as narrow as
    // IngestFunction's (see the construct's own comment).
    const statements = template.findResources('AWS::IAM::Policy');
    const allActions = JSON.stringify(statements);
    expect(allActions).not.toMatch(/s3:/);
  });

  test('defaults to a one-month log retention and a RETAIN log group', () => {
    const stack = newTestStack();
    const { jobQueue, jobDefinition } = buildBatchFixtures(stack);
    new ProcessingTrigger(stack, 'ProcessingTrigger', { jobQueue, jobDefinition });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', Match.objectLike({ RetentionInDays: 30 }));
    template.hasResource('AWS::Logs::LogGroup', Match.objectLike({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    }));
  });

  test('an explicit DESTROY removalPolicy overrides the log group\'s RETAIN default', () => {
    const stack = newTestStack();
    const { jobQueue, jobDefinition } = buildBatchFixtures(stack);
    new ProcessingTrigger(stack, 'ProcessingTrigger', {
      jobQueue,
      jobDefinition,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::Logs::LogGroup', Match.objectLike({
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    }));
  });
});
