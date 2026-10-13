# VoiceAI ASR 2.7.1.0 — Zipformer conversion for Qualcomm NPU

Notebook-driven toolchain that converts the streaming **Zipformer** transducer ASR
model from Xiaomi Corp.
([icefall `pruned_transducer_stateless7_streaming`](https://github.com/k2-fsa/icefall/tree/master/egs/librispeech/ASR/pruned_transducer_stateless7_streaming))
into fixed-point (8-bit weights / 16-bit activations, **`8w16a`**) models that run
on **Qualcomm low-power NPUs (eNPU)**.

It ships **two independent conversion pipelines** for the same model:

| Pipeline | Directory | Notebook | Target accelerator | SDK / backend | Compiler toolchain |
|---|---|---|---|---|---|
| **QNN-LPAI** | [`qnn/`](qnn/) | [`qnn/zipformer_qnn_conversion.ipynb`](qnn/zipformer_qnn_conversion.ipynb) | **eNPU v7** ("Hawaii") | Qualcomm **QAIRT / QNN SDK ≥ 2.44**, `libQnnLpai.so` | `qairt-converter` → `qnn-context-binary-generator` |
| **eAI** | [`eAI/`](eAI/) | [`eAI/zipformer_eai_conversion.ipynb`](eAI/zipformer_eai_conversion.ipynb) | **eNPU v6** ("Kaanapali") | Qualcomm **eAI SDK** (Hexagon SDK add-on, LPAI eNPU6 ≥ 5.10) | `eai_builder` |

Both pipelines start from the same PyTorch checkpoint, quantize with **AIMET**,
export an ONNX graph plus a quantization *encodings* file, then compile the
encoder / decoder / joiner into three fixed-point artifacts and finally pack them
(together with a VAD model) into a single end-to-end ASR model binary.

> **The notebooks are the primary documentation.** Each subtree's `README.md`
> only points at its notebook. Read `qnn/zipformer_qnn_conversion.ipynb` and
> `eAI/zipformer_eai_conversion.ipynb` for the authoritative, runnable steps;
> this file is the map.

---

## Supported model & languages

- **Architecture:** streaming Zipformer transducer (`Zipformer` + stateless
  `Decoder` + `Joiner`), trained for **mixed Chinese + English**.
- **Checkpoint:** [`pfluo/k2fsa-zipformer-chinese-english-mixed`](https://huggingface.co/pfluo/k2fsa-zipformer-chinese-english-mixed/tree/main/exp)
  (`epoch-99.pt` / `pretrained.pt`).
- **Input:** 16 kHz mono audio, 80-dim log-mel features (fbank).
- **Quantization:** `8w16a` (8-bit weights, 16-bit activations).
- **Chunk sizes:** encoder `decode_chunk_size` selects the streaming chunk —
  `32` → 640 ms, `16` → 320 ms (configurable in `net_config.json`).

Common network shape (`net_config.json`, both trees):

```
encoder: num_features=80, encoder_dims=(384,384,384,384,384),
         attention_dim=(192,...), feedforward_dim=(1024,1024,1536,1536,1024),
         num_encoder_layers=(2,4,3,2,4), decode_chunk_size=32|16
decoder: vocab_size=6254, decoder_dim=512, context_size=2
joiner : encoder_dim=384, decoder_dim=512, joiner_dim=512, vocab_size=6254
```

---

## Repository layout

```
.
├── qnn/                          # QNN-LPAI pipeline (eNPU v7)
│   ├── zipformer_qnn_conversion.ipynb   ← primary doc / driver
│   ├── README.md                        (points to the notebook)
│   ├── activate-cuda-12.4.sh            CUDA env vars for torch 2.6.0 / cu124
│   ├── requirements.txt
│   ├── backend_config.json              QNN net-run backend extension (LPAI)
│   ├── hw_config.json                   LPAI target: x86 / enpu v7
│   ├── config_for_qnn.json              AIMET quantsim config (per-op quant scheme)
│   ├── net_config.json                  model dimensions
│   ├── zipformer.py, decoder.py, joiner.py, encoder_interface.py, model.py
│   ├── model_wrapper.py                 streaming wrapper used for quantization
│   ├── mozilla.py, resample.py          dataset prep / calibration loader
│   ├── scaling.py, scaling_converter.py Zipformer scaling layers → non-scaled
│   ├── zipformer_quantize.py            AIMET quantization + ONNX export
│   ├── zipformer_edit.py                ONNX/encoding edits for the target backend
│   ├── zipformer_scale_encoding.py      activation-scaling tuning
│   ├── generate_pos_emb.py              positional-embedding raw inputs
│   ├── generate_accuracy_test_samples.py
│   ├── {encoder,decoder,joiner}_test_accuracy.py
│   ├── eAI_transcribe.py, eval_on_mozilla.py, *_eval_on_mozilla.py
│   ├── normalizers/                     text normalization (en)
│   ├── autoregressive_test/enc_init_status/*.raw
│   ├── scripts/                         encoder/decoder/joiner ONNX edit helpers,
│   │                                    framer.py, onnx_rectifier.py, onnx_run.py
│   ├── qnn_tools/                       replace_with_block_op.py,
│   │                                    generate_input_list.py,
│   │                                    update_encodings_for_qnn.py,
│   │                                    update_decoder_encodings_for_qnn.py,
│   │                                    config_file/qnnParams_v7.json,
│   │                                    {encoder,decoder,joiner}_inputs/*.raw
│   └── model_conversion_scripts/zipformer_q/
│       ├── generate_model_{cn,en}_8w16a_offload_v7_qnn_{320ms_enc_MT,
│       │                320ms_enc_non_MT,640ms_enc_MT}.sh   (6 variants)
│       ├── py/qnn_model_generation.py       packs the final e2e binary
│       ├── py/{cn,en}_dict_generation/      word dictionaries / tokens / vocab
│       └── model/zipformer_q.250804/qnn/nnvad_nonoffload_eai_v7.4.eai
│
├── eAI/                          # eAI pipeline (eNPU v6)
│   ├── zipformer_eai_conversion.ipynb   ← primary doc / driver
│   ├── README.md                        (points to the notebook)
│   ├── activate-cuda-11.6.sh            CUDA env vars for torch 1.13.1 / cu116
│   ├── requirements.txt
│   ├── config_for_eai.json              AIMET quantsim config
│   ├── net_config.json
│   ├── (same core converters as qnn/, e.g. zipformer_quantize.py,
│   │    zipformer_edit.py, model_wrapper.py, scaling*.py, mozilla.py, …)
│   ├── lpai_ops_preparer/               LPAI custom-op preparation
│   │                                    (HardSwish, LayerNorm, Clip, Mean, Pow, Sqrt)
│   ├── model_conversion_scripts/zipformer/
│   │   ├── generate_model_cn_en_8w16a_offload_eNPU_v6_eAI.sh
│   │   ├── py/eai_model_generation.py       packs the final e2e binary
│   │   ├── py/cn_dict_generation/
│   │   └── model/zipformer.250221/eai/nnvad_nonoffload_eai_v5.6.eai
│   └── normalizers/, autoregressive_test/, scripts/, qnn_tools/ (eaiParams_v6.json)
│
└── _refs/hanoi_cowork -> ../../hanoi_cowork   # external symlink, NOT part of this project
```

`qnn/` and `eAI/` share most source files (they differ only in the SDK-specific
pieces noted above: backend configs, `*_model_generation.py`, the packing shell
scripts, and the eAI-only `lpai_ops_preparer/`).

---

## The shared 6-step workflow

Both notebooks follow the same arc:

1. **Environment setup** — conda env, CUDA toolkit, torch, `k2`, `lhotse`,
   `kaldifeat`, AIMET. (Details differ per pipeline — see below.)
2. **Prepare datasets** — Mozilla Common Voice Corpus 9.0 subset
   ([qualcomm/voiceai-dataset](https://github.com/qualcomm/voiceai-dataset/releases)),
   then `copy_samples_from_commonvoice.py` and `resample.py` to 16 kHz mono WAV.
   ~1000–1500 EN + ~1000–1500 ZH samples are used for calibration.
3. **Quantize with AIMET** — `zipformer_quantize.py` per component
   (`encoder` / `decoder` / `joiner`) produces an ONNX model + `.encodings`,
   then `zipformer_edit.py` rewrites the three graphs/encodings so they are
   backend-friendly (framer → reset tensors, output/input quant alignment).
4. **Compile** to the target format (QNN context binaries, or `.eai` models).
5. **Tune accuracy** — compare fixed-point vs. float output by **cosine
   similarity** (target ≳ 0.99); if low, scale activation encodings with
   `zipformer_scale_encoding.py` (encoder/decoder/joiner scaled *together*) and
   recompile. Repeat until satisfied.
6. **Pack** the three components (+ VAD) into one end-to-end binary with the
   `generate_model_*.sh` scripts.

---

## Pipeline details

### `qnn/` — QNN-LPAI (eNPU v7)

- **Host env:** Ubuntu 22.04, Python **3.10**, PyTorch **2.6.0 + CUDA 12.4**,
  `aimet-torch==2.20.0`. Build `k2`/`kaldifeat` for `cuda12.4.torch2.6.0`.
  `source qnn/activate-cuda-12.4.sh` (edit `CUDA_HOME`).
- **Runtime SDK:** QAIRT / QNN SDK **≥ 2.44**; `source qairt/<ver>/bin/envsetup.sh`
  once per shell. Compilation uses the **LPAI backend** by default
  (`--target_backend LPAI`, `libQnnLpai.so`, `qnnParams_v7.json`, enpu **v7**).
- **Outputs** (in `aimet_exports/`, per notebook §Overview):
  - `qnn_zipformer_encoder_with_buffer.bin` (encoder; framers replaced by a shared
    reset tensor via `replace_with_block_op.py`)
  - `qnn_zipformer_decoder.bin`
  - `qnn_zipformer_joiner.bin`
- **Accuracy testing** uses `qnn-net-run --retrieve_context` on the compiled
  binaries vs. the float `*_native.onnx` references (`*_test_accuracy.py`).
- **Packing:** drop the three `.bin`s into
  `model_conversion_scripts/zipformer_q/model/zipformer_q.<date>/qnn/`, rename them
  `zipformer_{encoder,decoder,joiner}_v2_qnn_<ver>.bin`, then run e.g.
  `generate_model_en_8w16a_offload_v7_qnn_320ms_enc_MT.sh`.
  Final artifact name pattern:
  `<MODELNAME>.<MODELTYPE>.<QUANT>.qnn_v<QNN_VER>.enpu_v<ENPU_VER>[_MT]_<chunk>ms.bin`
  (e.g. `zipformer_q.250804.en.8w16a.qnn_v2.47.enpu_v7_MT_320ms.bin`).
  Variants: `cn`/`en` × 320 ms / 640 ms, multi-threaded (`_MT`) or not.

### `eAI/` — eAI (eNPU v6)

- **Host env:** Ubuntu 22.04, Python **3.8**, PyTorch **1.13.1 + CUDA 11.6**,
  **AIMET Pro 1.28** (QPM3 install; torch-gpu wheels). Build `k2`/`kaldifeat`
  for `cuda11.6.torch1.13.1`. `source eAI/activate-cuda-11.6.sh`.
- **Runtime SDK:** eAI SDK inside Hexagon SDK (LPAI **eNPU6 ≥ 5.10**). Tools:
  - `eai_builder`  — ONNX → `.eai` fixed-point model
  - `eai_quantize` — quantize/dequantize model I/O
  - `eai_sample_app` — execute an eAI model on given inputs
  Copied into `./eai_tools/`. Build flag: `--enable_enpu_ver v6 --enable_hw_cfg 1`.
- **Outputs** (in `aimet_exports/`): `zipformer_{encoder,decoder,joiner}.eai`, plus
  the QNN-with-eAI-backend `.bin`s.
- **Accuracy testing** via `*_test_accuracy.py` (uses `eai_quantize` +
  `eai_sample_app`); scaling factors can be read back in **Netronix**
  (`$EAI_SDK_ROOT/netronix`) and hard-coded in `py/eai_model_generation.py`.
- **Packing:** move the three `.eai`s into
  `model_conversion_scripts/zipformer/model/zipformer.250221/eai/` as
  `zipformer_{encoder,decoder,joiner}_offload_eai_v5.10.eai`, then run
  `generate_model_cn_en_8w16a_offload_eNPU_v6_eAI.sh`.
  Final artifact:
  `zipformer.250221.<TYPE>.8w16a.eai_v5.10.enpu_v6.offload.eai`.

---

## Requirements (host)

Both pipelines need an **NVIDIA CUDA GPU** for the AIMET quantization step,
plus the standard audio/tooling packages:

```bash
sudo apt install -y sox libsox-fmt-all ffmpeg parallel
```

Python packages are in `qnn/requirements.txt` and `eAI/requirements.txt`
(`kaldifst`, `kaldilm`, `kaldialign`, `num2words`, `kaldi-decoder`,
`sentencepiece`, `pypinyin`, `onnx*`, `transformers`, `tokenizers`,
`jiwer`, `pycantonese`, style tools…). **Note: ROCm is not supported** — the
conversion stack (AIMET, prebuilt `k2`/`kaldifeat` wheels, CUDA-AMP code paths)
is CUDA/NVIDIA-only, and deployment targets Qualcomm NPUs.

| | QNN pipeline | eAI pipeline |
|---|---|---|
| Python | 3.10 | 3.8 |
| PyTorch | 2.6.0 | 1.13.1 |
| CUDA | 12.4 | 11.6 |
| Quantizer | `aimet-torch` 2.20.0 | AIMET Pro 1.28 |
| Compiler SDK | QAIRT/QNN ≥ 2.44 | eAI SDK (Hexagon) ≥ 5.10 |
| eNPU | v7 | v6 |

---

## Data & model inputs

- **Calibration/eval data:** Common Voice 9.0 subset for Zipformer
  (1000–1500 EN + 1000–1500 ZH). Placed under `./cv-corpus-9.0-2022-04-27/`,
  copied to `./mozilla/{en,zh-CN}` and resampled to `./mozilla_16k/{en,zh-CN}`.
- **Checkpoint:** downloaded via `huggingface_hub.snapshot_download` into
  `./ckpt/exp/`.
- **Working dir assumptions:** run the notebook from inside its own subtree
  (`qnn/` or `eAI/`); paths such as `aimet_exports/`, `pos_emb/`,
  `preprocessed_samples/`, `qnn_tools/*` are relative to the notebook.

---

## Gotchas

- **`decode_chunk_size` drives everything.** Changing it in `net_config.json`
  requires regenerating positional embeddings (`generate_pos_emb.py`) and the
  encoder accuracy samples. Keep `tail_padding_sec` equal to the chunk size.
- **AIMET assertion** `Conflicting tensor quantizer settings for
  is_input_quantized`: comment out the assertion block in
  `aimet_torch/quantsim_config/quantsim_config.py` (line ranges depend on the
  AIMET version) per the QNN notebook note.
- **Scale the three models together.** The joiner's two input activations are
  quantized to match the encoder/decoder outputs; adjusting one without the
  others degrades fixed-point accuracy.
- **Encoder framer ops** can't run in vanilla `onnxruntime` — use the bundled
  `scripts/onnx_run.py` / `onnx_rectifier.py`; QNN replaces framers with reset
  tensors first (`qnn_tools/replace_with_block_op.py`).
- **`backend_config.json`** contains placeholder paths
  (`<path-to-your-qnn-sdk>`, `<path-to-this-...>`); edit them for your machine.
- The tree carries Qualcomm **"Confidential and Proprietary"** headers in
  several files — treat the repo accordingly.

---

## Licensing / provenance

- Zipformer model code derives from **icefall / Xiaomi Corp.** (Apache-2.0);
  individual file headers retain their original copyright.
- Qualcomm-specific tooling and generated artifacts are marked
  *Confidential and Proprietary - Qualcomm Technologies, Inc.*
