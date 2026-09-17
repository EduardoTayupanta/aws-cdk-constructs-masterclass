import type { S3Event } from 'aws-lambda';
import { BatchClient, SubmitJobCommand } from '@aws-sdk/client-batch';
import type { handler as HandlerType } from '../../lambda/processing-trigger';

const JOB_QUEUE_ARN = 'arn:aws:batch:us-east-1:123456789012:job-queue/test-queue';
const JOB_DEFINITION_ARN = 'arn:aws:batch:us-east-1:123456789012:job-definition/test-def:1';

// The handler module reads JOB_QUEUE_ARN/JOB_DEFINITION_ARN from process.env
// at module-load time (top-level consts), so the env vars must be set
// *before* the module is first required — a plain top-of-file `import`
// would be hoisted ahead of any `process.env` assignment. A plain `require`
// inside `beforeAll` (not `jest.isolateModules`, which would also fork a
// second copy of `@aws-sdk/client-batch` and break the `BatchClient`
// prototype spy below) guarantees the ordering while keeping module
// identity shared with the statically-imported `BatchClient`.
let handler: typeof HandlerType;

beforeAll(() => {
  process.env.JOB_QUEUE_ARN = JOB_QUEUE_ARN;
  process.env.JOB_DEFINITION_ARN = JOB_DEFINITION_ARN;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  handler = require('../../lambda/processing-trigger').handler;
});

function makeEvent(records: Array<{ bucket: string; key: string }>): S3Event {
  return {
    Records: records.map(({ bucket, key }) => ({
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: 'us-east-1',
      eventTime: '2024-01-01T00:00:00.000Z',
      eventName: 'ObjectCreated:Put',
      userIdentity: { principalId: 'AWS:EXAMPLE' },
      requestParameters: { sourceIPAddress: '127.0.0.1' },
      responseElements: {
        'x-amz-request-id': 'EXAMPLE123',
        'x-amz-id-2': 'EXAMPLE123',
      },
      s3: {
        s3SchemaVersion: '1.0',
        configurationId: 'testConfigRule',
        bucket: {
          name: bucket,
          ownerIdentity: { principalId: 'EXAMPLE' },
          arn: `arn:aws:s3:::${bucket}`,
        },
        object: {
          key,
          size: 1024,
          eTag: 'example-etag',
          sequencer: '0055AED6DCD90281E5',
        },
      },
    })) as S3Event['Records'],
  };
}

describe('processing-trigger handler', () => {
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    sendSpy = jest.spyOn(BatchClient.prototype, 'send').mockResolvedValue({} as never);
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  it('submits a Batch job with jobQueue/jobDefinition from env vars', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'manifests/raw/file.txt.json' }]);

    await handler(event);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const command = sendSpy.mock.calls[0][0];
    expect(command).toBeInstanceOf(SubmitJobCommand);
    expect(command.input.jobQueue).toBe(JOB_QUEUE_ARN);
    expect(command.input.jobDefinition).toBe(JOB_DEFINITION_ARN);
  });

  it('derives containerOverrides.environment from the S3 record bucket/key', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'manifests/raw/file.txt.json' }]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    expect(command.input.containerOverrides).toEqual({
      environment: [
        { name: 'MANIFEST_BUCKET', value: 'my-pipeline-bucket' },
        { name: 'MANIFEST_KEY', value: 'manifests/raw/file.txt.json' },
      ],
    });
  });

  it('URL-decodes and un-plusses the manifest key from the S3 event', async () => {
    const event = makeEvent([
      { bucket: 'my-pipeline-bucket', key: 'manifests/raw/some+folder/my%20file.txt.json' },
    ]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    expect(command.input.containerOverrides).toEqual({
      environment: [
        { name: 'MANIFEST_BUCKET', value: 'my-pipeline-bucket' },
        { name: 'MANIFEST_KEY', value: 'manifests/raw/some folder/my file.txt.json' },
      ],
    });
  });

  it('submits one Batch job per record for multi-record events', async () => {
    const event = makeEvent([
      { bucket: 'bucket-a', key: 'manifests/raw/a.json' },
      { bucket: 'bucket-b', key: 'manifests/raw/b.json' },
    ]);

    await handler(event);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const firstCommand = sendSpy.mock.calls[0][0];
    const secondCommand = sendSpy.mock.calls[1][0];
    expect(firstCommand.input.containerOverrides.environment).toContainEqual({
      name: 'MANIFEST_BUCKET',
      value: 'bucket-a',
    });
    expect(secondCommand.input.containerOverrides.environment).toContainEqual({
      name: 'MANIFEST_BUCKET',
      value: 'bucket-b',
    });
  });
});
