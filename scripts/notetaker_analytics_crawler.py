#!/usr/bin/env python3
"""
Batch crawler: list S3 meeting transcripts, parse speakers, optional Groq insights.

Requires: boto3, requests (pip install boto3 requests)

Env:
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET (or S3_BUCKET)
  GROQ_API_KEY (optional, for --insights)
  GROQ_MODEL (optional, default llama-3.1-8b-instant)
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3

try:
    import requests
except ImportError:
    requests = None  # type: ignore

TRANSCRIPT_BASE = "alyson-notetaker/transcripts/"
LINE_RE = re.compile(r"^([^:]+):\s*(.+)$")


def parse_utterances(text: str) -> list[dict[str, Any]]:
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = LINE_RE.match(line)
        speaker = (m.group(1) if m else "Speaker").strip()
        body = (m.group(2) if m else line).strip()
        if not body:
            continue
        words = len(body.split())
        out.append({"speaker": speaker, "text": body, "words": words})
    return out


def list_meeting_prefixes(s3, bucket: str) -> list[str]:
    paginator = s3.get_paginator("list_objects_v2")
    prefixes: set[str] = set()
    for page in paginator.paginate(Bucket=bucket, Prefix=TRANSCRIPT_BASE, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            p = cp.get("Prefix", "")
            if p.startswith(TRANSCRIPT_BASE):
                prefixes.add(p[len(TRANSCRIPT_BASE) :].rstrip("/"))
    return sorted(prefixes)


def prefix_day(prefix: str) -> str | None:
    parts = prefix.split("_")
    if len(parts) < 2:
        return None
    date = parts[-2]
    if re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        return date
    return None


def groq_insights(report: dict) -> str:
    if not requests:
        raise RuntimeError("pip install requests for --insights")
    key = os.environ.get("GROQ_API_KEY") or os.environ.get("ALYSON_MINI_MODULE_AI_API_KEY")
    if not key:
        raise RuntimeError("Set GROQ_API_KEY")
    model = os.environ.get("GROQ_MODEL") or os.environ.get("ALYSON_MINI_MODULE_AI_MODEL") or "llama-3.1-8b-instant"
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "temperature": 0.2,
            "messages": [
                {
                    "role": "system",
                    "content": "Summarize meeting speaker analytics in Markdown. Use only JSON facts.",
                },
                {"role": "user", "content": json.dumps(report, indent=2)},
            ],
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def main() -> None:
    ap = argparse.ArgumentParser(description="Notetaker S3 speaker analytics crawler")
    ap.add_argument("--days", type=int, default=30, help="Look back N days from today (UTC)")
    ap.add_argument("--speaker", default="", help="Filter speaker name contains")
    ap.add_argument("--max", type=int, default=50, help="Max meetings to analyze")
    ap.add_argument("--insights", action="store_true", help="Call Groq for narrative summary")
    ap.add_argument("--out", default="", help="Write JSON report to file")
    args = ap.parse_args()

    bucket = os.environ.get("AWS_S3_BUCKET") or os.environ.get("S3_BUCKET")
    if not bucket:
        raise SystemExit("Set AWS_S3_BUCKET or S3_BUCKET")

    region = os.environ.get("AWS_REGION") or os.environ.get("S3_REGION") or "us-east-1"
    s3 = boto3.client("s3", region_name=region)

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=args.days)
    speaker_f = args.speaker.strip().lower()

    prefixes = list_meeting_prefixes(s3, bucket)
    meetings = []
    global_speakers: dict[str, dict[str, Any]] = defaultdict(lambda: {"utterances": 0, "words": 0, "meetings": set()})

    for prefix in prefixes:
        day = prefix_day(prefix)
        if not day or day < start.isoformat() or day > end.isoformat():
            continue
        key = f"{TRANSCRIPT_BASE}{prefix}/transcript.txt"
        try:
            obj = s3.get_object(Bucket=bucket, Key=key)
            text = obj["Body"].read().decode("utf-8", errors="replace")
        except s3.exceptions.NoSuchKey:
            continue
        utterances = parse_utterances(text)
        roll: dict[str, dict[str, int]] = defaultdict(lambda: {"utterances": 0, "words": 0})
        for u in utterances:
            roll[u["speaker"]]["utterances"] += 1
            roll[u["speaker"]]["words"] += u["words"]
        speakers = sorted(roll.items(), key=lambda x: (-x[1]["utterances"], -x[1]["words"]))
        if speaker_f:
            speakers = [(n, s) for n, s in speakers if speaker_f in n.lower()]
            if not speakers:
                continue
        meetings.append(
            {
                "prefix": prefix,
                "day": day,
                "speakers": [{"speaker": n, **s} for n, s in speakers],
                "total_utterances": sum(s["utterances"] for _, s in speakers),
            }
        )
        for name, stats in speakers:
            g = global_speakers[name]
            g["utterances"] += stats["utterances"]
            g["words"] += stats["words"]
            g["meetings"].add(prefix)
        if len(meetings) >= args.max:
            break

    top = sorted(
        [
            {
                "speaker": n,
                "utterances": d["utterances"],
                "words": d["words"],
                "meetings_spoken": len(d["meetings"]),
            }
            for n, d in global_speakers.items()
        ],
        key=lambda x: (-x["utterances"], -x["words"]),
    )

    report = {
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "analyzed_count": len(meetings),
        "unique_speakers": len(global_speakers),
        "top_speakers": top[:20],
        "meetings": meetings,
    }

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"Wrote {args.out}")

    print(json.dumps({"analyzed": len(meetings), "unique_speakers": len(global_speakers), "top": top[:5]}, indent=2))

    if args.insights:
        print("\n--- Groq insights ---\n")
        print(groq_insights(report))


if __name__ == "__main__":
    main()
