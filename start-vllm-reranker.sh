#!/bin/bash
# Bundle A Phase 3 — vLLM reranker (Qwen3-Reranker-4B) launcher.
# Co-resides with the embedder on port 8800.
#
# GPU budget (RTX 3090, 24 GB total, ~4.2 GB Windows desktop overhead):
#   embedder  ~9.6 GB  (--gpu-memory-utilization 0.40)
#   reranker  ~6   GB  (--gpu-memory-utilization 0.25)
#   total     ~19.8 GB → ~4 GB headroom
#
# Qwen3-Reranker requires --hf_overrides + --chat-template to load as
# Qwen3ForSequenceClassification with yes/no token logits as the score head.
# Without these, vLLM loads it as a generic causal LM and the /v1/rerank scores
# are meaningless similarity values (verified by recall@1 collapse on 2026-05-14).
# Source: https://docs.vllm.ai/en/latest/examples/pooling/score
#
# Launch as a persistent daemon:
#   nohup bash /mnt/c/Users/djwmo/dev/claude-memory/start-vllm-reranker.sh > /tmp/vllm-reranker.log 2>&1 &

export HF_HUB_DISABLE_SYMLINKS_WARNING=1

exec /home/djwmo/.venv/vllm/bin/vllm serve Qwen/Qwen3-Reranker-4B \
  --runner pooling \
  --hf_overrides '{"architectures": ["Qwen3ForSequenceClassification"], "classifier_from_token": ["no", "yes"], "is_original_qwen3_reranker": true}' \
  --chat-template /mnt/c/Users/djwmo/dev/claude-memory/scripts/qwen3_reranker.jinja \
  --quantization bitsandbytes \
  --load-format bitsandbytes \
  --dtype auto \
  --gpu-memory-utilization 0.25 \
  --max-model-len 8192 \
  --port 8001
