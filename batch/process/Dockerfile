# syntax=docker/dockerfile:1

# A plain Python image, not a Lambda base image — this runs as an ECS/Fargate
# task under AWS Batch, not a Lambda function. `-slim` keeps the pulled image
# small, which matters here: this task runs in an isolated subnet with no NAT
# and only a handful of VPC interface endpoints (see docs/04-batch-processing.md
# for that trade-off) — every extra layer is one more thing time-boxed by the
# job's own timeout to pull through those endpoints.
FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY process.py ./

ENTRYPOINT ["python", "process.py"]
