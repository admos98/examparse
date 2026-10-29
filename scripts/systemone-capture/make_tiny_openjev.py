"""Write a tiny random-weight llama-architecture GGUF tagged as an openjev decision model.

Purpose: exercise the REAL llama-server /v1/systemone code path (request validation + answer
formatting) so the response envelope shape can be captured, not guessed. Weights are random, so
probabilities are meaningless; only the wire shape matters.
"""
import sys
import numpy as np
import gguf

# usage: make_tiny_openjev.py OUT.gguf [--peaked]
#   --peaked adds the server's own llama.decision.score_bias.5.1 metadata so the SAME code path returns a
#   confident distribution (used for the "peaked" capture).
OUT = sys.argv[1] if len(sys.argv) > 1 else "tiny-openjev.gguf"
PEAKED = "--peaked" in sys.argv[2:]

def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b); cs.append(256 + n); n += 1
    return [chr(c) for c in cs]

rng = np.random.default_rng(42)
tokens = bytes_to_unicode() + ["ab", "<|endoftext|>"]
n_vocab, n_embd, n_ff, n_head, n_layer = len(tokens), 64, 128, 2, 1
w = gguf.GGUFWriter(OUT, "llama")
w.add_name("tiny-openjev-capture")
w.add_context_length(2048)
w.add_embedding_length(n_embd)
w.add_block_count(n_layer)
w.add_feed_forward_length(n_ff)
w.add_head_count(n_head)
w.add_head_count_kv(n_head)
w.add_layer_norm_rms_eps(1e-5)
w.add_rope_dimension_count(n_embd // n_head)
w.add_vocab_size(n_vocab)
w.add_file_type(gguf.LlamaFileType.ALL_F32)
w.add_tokenizer_model("gpt2")
w.add_tokenizer_pre("default")
w.add_token_list(tokens)
w.add_token_types([gguf.TokenType.NORMAL] * (n_vocab - 1) + [gguf.TokenType.CONTROL])
w.add_token_merges(["a b"])
w.add_bos_token_id(n_vocab - 1)
w.add_eos_token_id(n_vocab - 1)
w.add_add_bos_token(False)
w.add_string("llama.decision.type", "openjev")
if PEAKED:
    w.add_string("llama.decision.score_bias.5.1", "4.0")
# Minimal systemone template: the server renders state/instructions/options through it.
w.add_string("tokenizer.chat_template.systemone",
             "Q: {{ instructions }}\n{% for o in options %}{{ o }}\n{% endfor %}S: {{ state }}\nA:")

def t(name, *shape):
    w.add_tensor(name, (rng.standard_normal(shape) * 0.05).astype(np.float32))

t("token_embd.weight", n_vocab, n_embd)
w.add_tensor("output_norm.weight", np.ones(n_embd, dtype=np.float32))
t("output.weight", n_vocab, n_embd)
for i in range(n_layer):
    w.add_tensor(f"blk.{i}.attn_norm.weight", np.ones(n_embd, dtype=np.float32))
    w.add_tensor(f"blk.{i}.ffn_norm.weight", np.ones(n_embd, dtype=np.float32))
    for n in ("attn_q", "attn_k", "attn_v", "attn_output"):
        t(f"blk.{i}.{n}.weight", n_embd, n_embd)
    t(f"blk.{i}.ffn_gate.weight", n_ff, n_embd)
    t(f"blk.{i}.ffn_up.weight", n_ff, n_embd)
    t(f"blk.{i}.ffn_down.weight", n_embd, n_ff)

w.write_header_to_file()
w.write_kv_data_to_file()
w.write_tensors_to_file()
w.close()
print("wrote", n_vocab, "tokens")
