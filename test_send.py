import asyncio
import httpx
import json
import base64
import os
import uuid
import sys

TARGET = "agent1qdafg4whsrjrpzgmn47pvus9g7uwzn38jrql4cese7dg54nkuqwtj2kkztt"
TARGET_LOCAL = "http://127.0.0.1:8002/submit"

# Try direct POST with the minimum expected format to see what happens
async def test_direct_post():
    # Build a minimal ChatMessage-like payload manually
    # The uagents /submit endpoint format
    payload = {
        "sender": "agent1qwk0me3ja063qtu6wdrnghs8yd9eqqmu2vzufvhdxkkv4m29u84dgw8jdjy",
        "target": TARGET,
        "session": str(uuid.uuid4()),
        "schema_digest": "model:708d789bb90c0bf61afe47aa4e3bb9a4",  # ChatMessage
        "protocol_digest": "proto:30a801ed3a83f9a0ff0a9f1e6fe958cb91da1fc2218b153df7b6cbf87bd33d62",
        "payload": base64.b64encode(b'{"content": [{"type": "text", "text": "Hello from hy4-predict!"}]}').decode(),
    }
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.post(TARGET_LOCAL, json=payload)
            print(f"Status: {r.status_code}")
            print(f"Response: {r.text[:300]}")
        except Exception as e:
            print(f"Error: {e}")

asyncio.run(test_direct_post())
