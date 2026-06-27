#!/bin/bash
python -m uvicorn app.server:app --host 0.0.0.0 --port 8787
