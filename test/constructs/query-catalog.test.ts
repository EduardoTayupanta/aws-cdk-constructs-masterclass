import { App, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { QueryCatalog } from '../../lib/constructs/query-catalog';
import * as cdkJson from '../../cdk.json';

// See data-lake-bucket.test.ts for why cdk.json's feature flags are loaded
// explicitly instead of using a bare `new App()`.
function newTestStack(): Stack {
  return new Stack(new App({ context: cdkJson.context }), 'TestStack');
}

describe('QueryCatalog', () => {
  test('creates exactly one Glue database, one Glue table, and one Athena workgroup', () => {
    const stack = newTestStack();
    const bucket = new Bucket(stack, 'FixtureBucket');
    new QueryCatalog(stack, 'QueryCatalog', { sourceBucket: bucket });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::Glue::Database', 1);
    template.resourceCountIs('AWS::Glue::Table', 1);
    template.resourceCountIs('AWS::Athena::WorkGroup', 1);
  });

  test('the table points at sourceBucket\'s processed/ prefix and reads each line as one string column', () => {
    const stack = newTestStack();
    const bucket = new Bucket(stack, 'FixtureBucket');
    new QueryCatalog(stack, 'QueryCatalog', { sourceBucket: bucket });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Glue::Table', Match.objectLike({
      DatabaseName: 'pipeline_data',
      TableInput: Match.objectLike({
        Name: 'processed',
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: Match.objectLike({
          Location: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('/processed/$')]),
            ]),
          }),
          Columns: [Match.objectLike({ Name: 'line', Type: 'string' })],
          // U+0001 (SOH) as the field delimiter can't appear in a JSON
          // Lines file, so LazySimpleSerDe reads each row as one field.
          SerdeInfo: Match.objectLike({
            Parameters: { 'field.delim': '' },
          }),
        }),
      }),
    }));
    template.hasResource('AWS::Glue::Table', Match.objectLike({
      DependsOn: Match.arrayWith([Match.stringLikeRegexp('^QueryCatalogDatabase')]),
    }));
  });

  test('the workgroup enforces its own configuration and encrypts results under athena-results/', () => {
    const stack = newTestStack();
    const bucket = new Bucket(stack, 'FixtureBucket');
    new QueryCatalog(stack, 'QueryCatalog', { sourceBucket: bucket });
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Athena::WorkGroup', Match.objectLike({
      RecursiveDeleteOption: true,
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        ResultConfiguration: Match.objectLike({
          EncryptionConfiguration: { EncryptionOption: 'SSE_S3' },
          OutputLocation: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('/athena-results/$')]),
            ]),
          }),
        }),
      }),
    }));
  });

  test('defaults to RETAIN for the database, table, and workgroup', () => {
    const stack = newTestStack();
    const bucket = new Bucket(stack, 'FixtureBucket');
    new QueryCatalog(stack, 'QueryCatalog', { sourceBucket: bucket });
    const template = Template.fromStack(stack);

    for (const type of ['AWS::Glue::Database', 'AWS::Glue::Table', 'AWS::Athena::WorkGroup']) {
      template.hasResource(type, Match.objectLike({
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      }));
    }
  });

  test('an explicit DESTROY removalPolicy overrides the RETAIN default for all three resources', () => {
    const stack = newTestStack();
    const bucket = new Bucket(stack, 'FixtureBucket');
    new QueryCatalog(stack, 'QueryCatalog', { sourceBucket: bucket, removalPolicy: RemovalPolicy.DESTROY });
    const template = Template.fromStack(stack);

    for (const type of ['AWS::Glue::Database', 'AWS::Glue::Table', 'AWS::Athena::WorkGroup']) {
      template.hasResource(type, Match.objectLike({
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      }));
    }
  });

  test('grants no IAM permissions: Athena queries run as the caller, not as a role this construct owns', () => {
    const stack = newTestStack();
    const bucket = new Bucket(stack, 'FixtureBucket');
    new QueryCatalog(stack, 'QueryCatalog', { sourceBucket: bucket });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::Role', 0);
    template.resourceCountIs('AWS::IAM::Policy', 0);
  });
});
