import { Construct } from 'constructs';
import { RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnDatabase, CfnTable } from 'aws-cdk-lib/aws-glue';
import { CfnWorkGroup } from 'aws-cdk-lib/aws-athena';

export interface QueryCatalogProps {
  /** The bucket whose `processed/` prefix (Step 3's output) this catalogs. */
  readonly sourceBucket: IBucket;

  /**
   * What happens to the Glue database/table and Athena workgroup when the
   * stack is destroyed. None of the three hold pipeline data themselves —
   * only metadata and query history — but the default still favors not
   * silently dropping a catalog someone built saved queries against.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
}

/**
 * Lays a queryable schema over the `processed/` JSON Lines objects
 * `ProcessingJob` (Step 3) writes — a Glue Data Catalog database and table,
 * plus an Athena workgroup to query them from.
 *
 * Unlike every earlier step, there is no `aws-cdk-lib` L2 for Glue or
 * Athena to reach for — `aws-cdk-lib/aws-glue` and `aws-cdk-lib/aws-athena`
 * export only generated L1s (`Cfn*`). This construct *is* this step's L2:
 * the same "compose L1s behind one intent-revealing API" idea `DataLakeBucket`
 * (Step 1) demonstrated, applied because the ecosystem hasn't built one yet
 * rather than because a hand-rolled one was preferred over an available L2.
 *
 * There is deliberately no Glue Crawler here. `process.py` (Step 3) makes
 * no promise about its output's JSON shape beyond "one JSON value per
 * line" — a crawler would only ever be able to infer that same absence of
 * structure, at the cost of its own IAM role and a moving part with
 * nothing to show for it. The table instead declares a single `line`
 * string column (a field delimiter that can't occur in a JSON line keeps
 * each row intact) and queries reach into it with Presto/Trino's
 * `json_extract_scalar` — see docs/05-athena-glue.md for a worked example.
 */
export class QueryCatalog extends Construct {
  /** Glue database holding `table`. */
  public readonly database: CfnDatabase;

  /** Glue table over `sourceBucket`'s `processed/` prefix. */
  public readonly table: CfnTable;

  /** Athena workgroup queries against `table` should run in. */
  public readonly workGroup: CfnWorkGroup;

  public readonly databaseName: string;
  public readonly tableName: string;

  constructor(scope: Construct, id: string, props: QueryCatalogProps) {
    super(scope, id);

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const catalogId = Stack.of(this).account;
    this.databaseName = 'pipeline_data';
    this.tableName = 'processed';

    this.database = new CfnDatabase(this, 'Database', {
      catalogId,
      databaseInput: {
        name: this.databaseName,
        description: 'Masterclass pipeline: schema over Step 3\'s processed/ output.',
      },
    });
    this.database.applyRemovalPolicy(removalPolicy);

    this.table = new CfnTable(this, 'Table', {
      catalogId,
      databaseName: this.databaseName,
      tableInput: {
        name: this.tableName,
        tableType: 'EXTERNAL_TABLE',
        // Cosmetic metadata (shown in the Glue/Athena console) — the
        // SerDe below is what actually governs how a row is read.
        parameters: { classification: 'json' },
        storageDescriptor: {
          location: props.sourceBucket.s3UrlForObject('processed/'),
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            // U+0001 (SOH) can't appear in a JSON Lines file, so every row
            // is read as exactly one field: the whole line, untouched.
            parameters: { 'field.delim': '' },
          },
          columns: [{ name: 'line', type: 'string' }],
        },
      },
    });
    this.table.addResourceDependency(this.database);
    this.table.applyRemovalPolicy(removalPolicy);

    this.workGroup = new CfnWorkGroup(this, 'WorkGroup', {
      name: 'pipeline-queries',
      description: 'Queries the masterclass pipeline\'s processed/ data via Glue/Athena.',
      // Lets `cdk destroy` remove this workgroup even after it has run
      // queries — without it, CloudFormation refuses to delete a
      // workgroup with any query history.
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        // Query settings (below) apply regardless of what the calling
        // principal's own client passes — the workgroup is the source of
        // truth, not a default a caller could quietly override.
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: props.sourceBucket.s3UrlForObject('athena-results/'),
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    this.workGroup.applyRemovalPolicy(removalPolicy);
  }
}
