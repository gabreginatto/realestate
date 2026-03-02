#!/bin/bash
set -e
cd "$(dirname "$0")"
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
