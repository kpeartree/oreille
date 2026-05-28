"""Re-generate public/models/yamnet/ from TF Hub.

Usage:
    uv venv --python 3.11
    source .venv/bin/activate
    uv pip install 'tensorflow==2.15.*' tensorflow-hub 'tensorflowjs==4.17.*' 'setuptools<81'
    python scripts/convert-yamnet.py

YAMNet's TF Hub version has a dynamic input shape; we wrap it with a fixed
15360-sample input (0.96s @ 16kHz) so the resulting graph runs cleanly under
tfjs-converter and produces a static [1, 521] score tensor.
"""

import csv
import json
import os
import shutil

import tensorflow as tf
import tensorflow_hub as hub
from tensorflowjs.converters import tf_saved_model_conversion_v2 as conv

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAVED = os.path.join(ROOT, ".tmp", "saved_yamnet")
TFJS  = os.path.join(ROOT, "public", "models", "yamnet")
WIN   = 15360  # 0.96s * 16000 Hz

for d in (SAVED, TFJS):
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(d, exist_ok=True)

print("Loading YAMNet from TF Hub…")
yamnet = hub.load("https://tfhub.dev/google/yamnet/1")

class FixedYamnet(tf.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
    @tf.function(input_signature=[tf.TensorSpec(shape=[WIN], dtype=tf.float32)])
    def __call__(self, waveform):
        scores, _embeddings, _spectrogram = self.m(waveform)
        return {"scores": scores}

wrapped = FixedYamnet(yamnet)

print(f"Saving SavedModel to {SAVED}…")
tf.saved_model.save(wrapped, SAVED, signatures={"serving_default": wrapped.__call__})

print(f"Converting to TFJS GraphModel at {TFJS}…")
conv.convert_tf_saved_model(SAVED, TFJS, signature_def="serving_default", saved_model_tags="serve", skip_op_check=False, strip_debug_ops=True)

class_map_path = yamnet.class_map_path().numpy().decode("utf-8")
labels = []
with open(class_map_path) as f:
    reader = csv.reader(f)
    next(reader, None)
    for row in reader:
        labels.append(row[2])
with open(os.path.join(TFJS, "labels.json"), "w") as f:
    json.dump(labels, f)
print(f"{len(labels)} labels written. Done.")
