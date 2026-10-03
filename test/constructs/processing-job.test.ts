import { App, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ProcessingJob } from '../../lib/constructs/processing-job';
import * as cdkJson from '../../cdk.json';

// See data-lake-bucket.test.ts for why cdk.json's feature flags are loaded
// explicitly instead of using a bare `new App()`.
function newTestStack(): Stack {
  return new Stack(new App({ context: cdkJson.context }), 'TestStack');
}

describe('ProcessingJob', () => {
  const stack = newTestStack();
  new ProcessingJob(stack, 'ProcessingJob');
  const template = Template.fromStack(stack);

  test('wires exactly one compute environment, job queue, and job definition together', () => {
    template.resourceCountIs('AWS::Batch::ComputeEnvironment', 1);
    template.resourceCountIs('AWS::Batch::JobQueue', 1);
    template.resourceCountIs('AWS::Batch::JobDefinition', 1);
  });

  test('the job definition runs on Fargate, with no public IP, a 5-minute timeout, and 2 retries', () => {
    template.hasResourceProperties('AWS::Batch::JobDefinition', Match.objectLike({
      PlatformCapabilities: ['FARGATE'],
      ContainerProperties: Match.objectLike({
        NetworkConfiguration: { AssignPublicIp: 'DISABLED' },
        ResourceRequirements: Match.arrayWith([
          Match.objectLike({ Type: 'MEMORY', Value: '512' }),
          Match.objectLike({ Type: 'VCPU', Value: '0.25' }),
        ]),
      }),
      RetryStrategy: { Attempts: 2 },
      Timeout: { AttemptDurationSeconds: 300 },
    }));
  });

  test('the VPC is single-AZ, isolated-subnet-only, with no NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('the tasks reach S3 via a gateway endpoint and ECR/CloudWatch Logs via interface endpoints', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
    template.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' }, 1);
    template.resourcePropertiesCountIs('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Interface' }, 3);
    // Interface endpoints are `open: false` — restricted to the endpoints
    // security group rather than the whole VPC CIDR.
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', Match.objectLike({
      VpcEndpointType: 'Interface',
      SecurityGroupIds: Match.arrayWith([Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['GroupId']) })]),
    }));
  });

  test('neither security group allows all outbound traffic; only tasks -> endpoints on 443 is opened', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
    // `allowAllOutbound: false` on both SGs makes CDK emit the "disallow
    // all traffic" sentinel egress rule instead of a real 0.0.0.0/0 rule.
    template.resourcePropertiesCountIs('AWS::EC2::SecurityGroup', Match.objectLike({
      SecurityGroupEgress: [Match.objectLike({ Description: 'Disallow all traffic' })],
    }), 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', Match.objectLike({
      Description: 'Processing job tasks -> VPC interface endpoints',
      FromPort: 443,
      ToPort: 443,
      IpProtocol: 'tcp',
    }));
  });

  test('the job role is separate from the auto-created execution role, and starts with no grants of its own', () => {
    // ProcessingJob only creates jobRole and hands it back — every S3 grant
    // is added by the caller (see DataPipelineStack), not by this construct.
    // The one policy present belongs to the auto-created execution role
    // (container image pull + CloudWatch Logs), not to jobRole. The third
    // role belongs to the VPC's default-security-group-restriction custom
    // resource (@aws-cdk/aws-ec2:restrictDefaultSecurityGroup, on via
    // cdk.json), not to anything this construct's own code creates.
    template.resourceCountIs('AWS::IAM::Role', 3);
    template.resourceCountIs('AWS::IAM::Policy', 1);
    template.hasResourceProperties('AWS::IAM::Role', Match.objectLike({
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'ecs-tasks.amazonaws.com' } }),
        ]),
      }),
    }));
  });

  test('defaults to a one-month log retention and a RETAIN log group', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', Match.objectLike({ RetentionInDays: 30 }));
    template.hasResource('AWS::Logs::LogGroup', Match.objectLike({
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    }));
  });

  test('an explicit DESTROY removalPolicy overrides the log group\'s RETAIN default', () => {
    const destroyStack = newTestStack();
    new ProcessingJob(destroyStack, 'ProcessingJob', { removalPolicy: RemovalPolicy.DESTROY });
    const destroyTemplate = Template.fromStack(destroyStack);

    destroyTemplate.hasResource('AWS::Logs::LogGroup', Match.objectLike({
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    }));
  });
});
