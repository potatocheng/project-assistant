"""Loopback Ollama-compatible benchmark endpoint for the pinned MiniLM ONNX export."""
import hashlib
import json
import sys
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


model_file, tokenizer_file = map(Path, sys.argv[1:3])
assert hashlib.sha256(model_file.read_bytes()).hexdigest() == "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"
assert hashlib.sha256(tokenizer_file.read_bytes()).hexdigest() == "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"
tokenizer = Tokenizer.from_file(str(tokenizer_file))
tokenizer.enable_truncation(max_length=256)
tokenizer.enable_padding()
options = ort.SessionOptions()
options.intra_op_num_threads = 3
session = ort.InferenceSession(str(model_file), options, providers=["CPUExecutionProvider"])


@lru_cache(maxsize=16384)
def embed(text):
    item = tokenizer.encode(text)
    inputs = {name: np.array([values], dtype=np.int64) for name, values in (
        ("input_ids", item.ids), ("attention_mask", item.attention_mask),
        ("token_type_ids", item.type_ids))}
    embeddings = session.run(None, inputs)[0][0]
    pooled = embeddings[np.asarray(item.attention_mask, dtype=bool)].mean(axis=0)
    return (pooled / np.linalg.norm(pooled)).tolist()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/embed":
            return self.send_error(404)
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if request["model"] != "all-MiniLM-L6-v2":
            return self.send_error(400)
        data = json.dumps({"embeddings": [embed(text) for text in request["input"]]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_):
        pass


server = HTTPServer(("127.0.0.1", int(sys.argv[3]) if len(sys.argv) > 3 else 0), Handler)
print(f"http://127.0.0.1:{server.server_port}", flush=True)
server.serve_forever()
