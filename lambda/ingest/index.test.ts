import type { S3Event } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { handler } from './index';

function makeEvent(records: Array<{ bucket: string; key: string; size?: number }>): S3Event {
  return {
    Records: records.map(({ bucket, key, size = 2048 }) => ({
      eventVersion: '2.1',
      eventSource: 'aws:s3',
      awsRegion: 'us-east-1',
      eventTime: '2024-03-15T12:34:56.000Z',
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
          size,
          eTag: 'example-etag',
          sequencer: '0055AED6DCD90281E5',
        },
      },
    })) as S3Event['Records'],
  };
}

describe('ingest handler', () => {
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    sendSpy = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  it('derives the manifest key by stripping the raw/ prefix and appending .json', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'raw/2024/03/15/data.csv' }]);

    await handler(event);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const command = sendSpy.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe('my-pipeline-bucket');
    expect(command.input.Key).toBe('manifests/2024/03/15/data.csv.json');
  });

  it('replaces "+" with spaces in the object key (S3 event key encoding)', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'raw/some+folder/my+file.csv' }]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    expect(command.input.Key).toBe('manifests/some folder/my file.csv.json');
    const body = JSON.parse(command.input.Body as string);
    expect(body.sourceKey).toBe('raw/some folder/my file.csv');
  });

  it('percent-decodes the object key', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'raw/my%20file%20%281%29.csv' }]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    expect(command.input.Key).toBe('manifests/my file (1).csv.json');
    const body = JSON.parse(command.input.Body as string);
    expect(body.sourceKey).toBe('raw/my file (1).csv');
  });

  it('handles combined "+" and percent-encoding in the object key', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'raw/a+b%2Bc/file%20name.csv' }]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    // "+" is replaced with a literal space *before* percent-decoding, so a
    // literal "+" that was itself percent-encoded (%2B) survives as "+".
    expect(command.input.Key).toBe('manifests/a b+c/file name.csv.json');
  });

  it('writes a manifest body with bucket, sourceKey, sizeBytes, eventName, and eventTime', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'raw/report.txt', size: 4096 }]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    expect(command.input.ContentType).toBe('application/json');
    const body = JSON.parse(command.input.Body as string);
    expect(body).toEqual({
      bucket: 'my-pipeline-bucket',
      sourceKey: 'raw/report.txt',
      sizeBytes: 4096,
      eventName: 'ObjectCreated:Put',
      eventTime: '2024-03-15T12:34:56.000Z',
    });
  });

  it('processes multiple records in a single event, one PutObjectCommand each', async () => {
    const event = makeEvent([
      { bucket: 'bucket-a', key: 'raw/a.json' },
      { bucket: 'bucket-b', key: 'raw/nested/b.json' },
    ]);

    await handler(event);

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const firstCommand = sendSpy.mock.calls[0][0];
    const secondCommand = sendSpy.mock.calls[1][0];
    expect(firstCommand.input.Bucket).toBe('bucket-a');
    expect(firstCommand.input.Key).toBe('manifests/a.json.json');
    expect(secondCommand.input.Bucket).toBe('bucket-b');
    expect(secondCommand.input.Key).toBe('manifests/nested/b.json.json');
  });

  it('only strips a leading raw/ prefix, not one appearing elsewhere in the key', async () => {
    const event = makeEvent([{ bucket: 'my-pipeline-bucket', key: 'raw/raw/nested-raw-again.csv' }]);

    await handler(event);

    const command = sendSpy.mock.calls[0][0];
    expect(command.input.Key).toBe('manifests/raw/nested-raw-again.csv.json');
  });
});
