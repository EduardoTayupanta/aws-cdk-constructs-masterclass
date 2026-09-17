"""
Unit tests for process.py (the Step 3 Batch job).

Self-contained, matching this repo's per-component toolchain pattern: run
from within batch/process/ using the local venv set up by:

    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements-dev.txt
    pytest

Every boto3 S3 call is stubbed with unittest.mock — no real AWS access.
"""

import json
import os
import runpy
from unittest.mock import MagicMock, call

import boto3
import pytest

import process

PROCESS_PY_PATH = os.path.join(os.path.dirname(__file__), "process.py")


# --------------------------------------------------------------------------
# to_json_lines
# --------------------------------------------------------------------------


class TestToJsonLines:
    def test_json_array_becomes_one_line_per_element(self):
        raw = json.dumps([{"a": 1}, {"a": 2}, {"a": 3}]).encode("utf-8")

        result = process.to_json_lines(raw)

        lines = result.splitlines()
        assert lines == [
            json.dumps({"a": 1}),
            json.dumps({"a": 2}),
            json.dumps({"a": 3}),
        ]
        assert result.endswith("\n")

    def test_empty_json_array_produces_empty_output(self):
        raw = json.dumps([]).encode("utf-8")

        result = process.to_json_lines(raw)

        assert result == ""

    def test_single_json_object_becomes_one_line(self):
        raw = json.dumps({"name": "alice", "age": 30}).encode("utf-8")

        result = process.to_json_lines(raw)

        assert result == json.dumps({"name": "alice", "age": 30}) + "\n"

    def test_json_scalar_becomes_one_line(self):
        raw = json.dumps(42).encode("utf-8")

        result = process.to_json_lines(raw)

        assert result == json.dumps(42) + "\n"

    def test_plain_multiline_text_becomes_one_text_record_per_line(self):
        raw = b"first line\nsecond line\nthird line"

        result = process.to_json_lines(raw)

        lines = result.splitlines()
        assert lines == [
            json.dumps({"text": "first line"}),
            json.dumps({"text": "second line"}),
            json.dumps({"text": "third line"}),
        ]

    def test_plain_text_skips_blank_lines(self):
        raw = b"first line\n\n   \nsecond line\n"

        result = process.to_json_lines(raw)

        lines = result.splitlines()
        assert lines == [
            json.dumps({"text": "first line"}),
            json.dumps({"text": "second line"}),
        ]

    def test_plain_text_with_only_blank_lines_produces_empty_output(self):
        raw = b"\n\n   \n"

        result = process.to_json_lines(raw)

        assert result == ""


# --------------------------------------------------------------------------
# main()
# --------------------------------------------------------------------------


@pytest.fixture
def mock_s3(monkeypatch):
    """Replaces the module-level `process.s3` client with a MagicMock."""
    mock = MagicMock()
    monkeypatch.setattr(process, "s3", mock)
    return mock


def _body(data: bytes) -> MagicMock:
    """A stand-in for the StreamingBody returned by get_object()['Body']."""
    body = MagicMock()
    body.read.return_value = data
    return body


class TestMain:
    def test_happy_path_writes_expected_processed_key_and_body(self, monkeypatch, mock_s3):
        monkeypatch.setenv("MANIFEST_BUCKET", "my-pipeline-bucket")
        monkeypatch.setenv("MANIFEST_KEY", "manifests/2024/03/15/data.csv.json")

        manifest = {
            "bucket": "my-pipeline-bucket",
            "sourceKey": "raw/2024/03/15/data.csv",
            "sizeBytes": 123,
            "eventName": "ObjectCreated:Put",
            "eventTime": "2024-03-15T00:00:00.000Z",
        }
        raw_records = [{"a": 1}, {"a": 2}]

        mock_s3.get_object.side_effect = [
            {"Body": _body(json.dumps(manifest).encode("utf-8"))},
            {"Body": _body(json.dumps(raw_records).encode("utf-8"))},
        ]

        process.main()

        assert mock_s3.get_object.call_args_list == [
            call(Bucket="my-pipeline-bucket", Key="manifests/2024/03/15/data.csv.json"),
            call(Bucket="my-pipeline-bucket", Key="raw/2024/03/15/data.csv"),
        ]

        assert mock_s3.put_object.call_count == 1
        put_kwargs = mock_s3.put_object.call_args.kwargs
        assert put_kwargs["Bucket"] == "my-pipeline-bucket"
        assert put_kwargs["Key"] == "processed/2024/03/15/data.csv.jsonl"
        assert put_kwargs["ContentType"] == "application/x-ndjson"

        expected_body = (json.dumps({"a": 1}) + "\n" + json.dumps({"a": 2}) + "\n").encode("utf-8")
        assert put_kwargs["Body"] == expected_body

    def test_happy_path_with_plain_text_raw_object(self, monkeypatch, mock_s3):
        monkeypatch.setenv("MANIFEST_BUCKET", "my-pipeline-bucket")
        monkeypatch.setenv("MANIFEST_KEY", "manifests/log.txt.json")

        manifest = {"bucket": "my-pipeline-bucket", "sourceKey": "raw/log.txt"}

        mock_s3.get_object.side_effect = [
            {"Body": _body(json.dumps(manifest).encode("utf-8"))},
            {"Body": _body(b"line one\nline two\n")},
        ]

        process.main()

        put_kwargs = mock_s3.put_object.call_args.kwargs
        assert put_kwargs["Key"] == "processed/log.txt.jsonl"
        assert put_kwargs["Body"] == (
            json.dumps({"text": "line one"}) + "\n" + json.dumps({"text": "line two"}) + "\n"
        ).encode("utf-8")

    def test_manifest_bucket_mismatch_raises_and_does_not_write(self, monkeypatch, mock_s3):
        monkeypatch.setenv("MANIFEST_BUCKET", "trusted-bucket")
        monkeypatch.setenv("MANIFEST_KEY", "manifests/data.csv.json")

        # A tampered/buggy manifest claiming a different source bucket.
        manifest = {
            "bucket": "attacker-controlled-bucket",
            "sourceKey": "raw/data.csv",
        }
        mock_s3.get_object.side_effect = [
            {"Body": _body(json.dumps(manifest).encode("utf-8"))},
        ]

        with pytest.raises(ValueError, match="does not match the trusted"):
            process.main()

        # Only the manifest itself was read — the raw object was never
        # fetched, and nothing was ever written.
        assert mock_s3.get_object.call_count == 1
        mock_s3.put_object.assert_not_called()

    def test_processed_key_strips_only_leading_raw_prefix(self, monkeypatch, mock_s3):
        monkeypatch.setenv("MANIFEST_BUCKET", "my-pipeline-bucket")
        monkeypatch.setenv("MANIFEST_KEY", "manifests/raw/nested.json")

        manifest = {
            "bucket": "my-pipeline-bucket",
            "sourceKey": "raw/raw/nested.json",
        }
        mock_s3.get_object.side_effect = [
            {"Body": _body(json.dumps(manifest).encode("utf-8"))},
            {"Body": _body(json.dumps({"x": 1}).encode("utf-8"))},
        ]

        process.main()

        put_kwargs = mock_s3.put_object.call_args.kwargs
        assert put_kwargs["Key"] == "processed/raw/nested.json.jsonl"

    def test_missing_manifest_bucket_env_var_raises_key_error(self, monkeypatch, mock_s3):
        monkeypatch.delenv("MANIFEST_BUCKET", raising=False)
        monkeypatch.setenv("MANIFEST_KEY", "manifests/data.csv.json")

        with pytest.raises(KeyError):
            process.main()

        mock_s3.get_object.assert_not_called()


# --------------------------------------------------------------------------
# `if __name__ == "__main__":` guard
# --------------------------------------------------------------------------
#
# A plain `import process` never sets `__name__ == "__main__"`, so the
# bottom guard block (including its try/except around main() and the
# sys.exit(1) error path with traceback.print_exc()) is otherwise dead code
# from pytest's point of view. `runpy.run_path(..., run_name="__main__")`
# genuinely re-executes process.py as a script with `__name__` set to
# "__main__", so these tests exercise the real guard block end to end
# (including the process-exit behavior) rather than calling main() directly.
# boto3.client is monkeypatched (mirroring how the rest of this file
# monkeypatches `process.s3`) so the freshly-executed module's own
# `s3 = boto3.client("s3")` picks up a mock instead of touching real AWS.


class TestDunderMainGuard:
    def test_success_path_runs_main_without_exiting(self, monkeypatch, capsys):
        mock = MagicMock()
        monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: mock)
        monkeypatch.setenv("MANIFEST_BUCKET", "my-pipeline-bucket")
        monkeypatch.setenv("MANIFEST_KEY", "manifests/report.txt.json")

        manifest = {"bucket": "my-pipeline-bucket", "sourceKey": "raw/report.txt"}
        mock.get_object.side_effect = [
            {"Body": _body(json.dumps(manifest).encode("utf-8"))},
            {"Body": _body(b"hello\n")},
        ]

        # No SystemExit means the guard's try block completed normally.
        runpy.run_path(PROCESS_PY_PATH, run_name="__main__")

        assert mock.put_object.call_count == 1
        put_kwargs = mock.put_object.call_args.kwargs
        assert put_kwargs["Key"] == "processed/report.txt.jsonl"

    def test_error_path_prints_traceback_and_exits_1(self, monkeypatch, capsys):
        mock = MagicMock()
        monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: mock)
        # No MANIFEST_BUCKET/MANIFEST_KEY set, so main() raises KeyError
        # before ever touching S3 — the guard's except clause must catch it,
        # print the traceback, and exit with status 1.
        monkeypatch.delenv("MANIFEST_BUCKET", raising=False)
        monkeypatch.delenv("MANIFEST_KEY", raising=False)

        with pytest.raises(SystemExit) as exc_info:
            runpy.run_path(PROCESS_PY_PATH, run_name="__main__")

        assert exc_info.value.code == 1
        mock.get_object.assert_not_called()

        captured = capsys.readouterr()
        assert "Traceback" in captured.err
        assert "KeyError" in captured.err
