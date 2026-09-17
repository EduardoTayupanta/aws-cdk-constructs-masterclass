"""
Step 3 Batch job: turns one raw object into a queryable, newline-delimited
JSON ("JSON Lines") object under `processed/` — the layer Athena (Step 4)
will point a table at.

Invoked by `ProcessingTrigger` (a Lambda, see lambda/processing-trigger/)
with `MANIFEST_BUCKET` / `MANIFEST_KEY` as container environment overrides.
This job never receives the raw object's key directly — it reads the
manifest `IngestFunction` (Step 2) already wrote, which is the one place
that mapping is recorded. That's a deliberate seam: the trigger only
forwards *which manifest fired*, and everything about *what to do with it*
lives in application code, not in the wiring between services.
"""

import json
import os
import sys

import boto3

s3 = boto3.client("s3")


def to_json_lines(raw_bytes: bytes) -> str:
    """
    Normalizes arbitrary input into JSON Lines (one JSON value per line):

    - A JSON array becomes one line per element.
    - A single JSON object (or any other JSON scalar) becomes one line.
    - Anything that isn't valid JSON is treated as text, one line per
      non-empty input line, each wrapped as {"text": "..."}.

    This is intentionally simple — the point of this step is wiring Batch
    into the pipeline correctly, not building a general-purpose ETL job.
    """
    try:
        parsed = json.loads(raw_bytes)
    except json.JSONDecodeError:
        lines = raw_bytes.decode("utf-8", errors="replace").splitlines()
        return "".join(
            json.dumps({"text": line}) + "\n" for line in lines if line.strip()
        )

    records = parsed if isinstance(parsed, list) else [parsed]
    return "".join(json.dumps(record) + "\n" for record in records)


def main() -> None:
    manifest_bucket = os.environ["MANIFEST_BUCKET"]
    manifest_key = os.environ["MANIFEST_KEY"]

    print(f"Reading manifest s3://{manifest_bucket}/{manifest_key}")
    manifest_obj = s3.get_object(Bucket=manifest_bucket, Key=manifest_key)
    manifest = json.loads(manifest_obj["Body"].read())

    source_bucket = manifest["bucket"]
    source_key = manifest["sourceKey"]

    print(f"Reading raw object s3://{source_bucket}/{source_key}")
    raw_obj = s3.get_object(Bucket=source_bucket, Key=source_key)
    body = to_json_lines(raw_obj["Body"].read())

    processed_key = "processed/" + source_key.removeprefix("raw/") + ".jsonl"
    print(f"Writing s3://{source_bucket}/{processed_key}")
    s3.put_object(
        Bucket=source_bucket,
        Key=processed_key,
        Body=body.encode("utf-8"),
        ContentType="application/x-ndjson",
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Let AWS Batch see a non-zero exit code (and record the job as
        # FAILED) rather than swallowing the error — the traceback already
        # goes to stderr, which Batch's awslogs driver ships to CloudWatch.
        import traceback

        traceback.print_exc()
        sys.exit(1)
