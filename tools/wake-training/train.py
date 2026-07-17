"""Train the wake-word classifier head and export it as ONNX.

The head is deliberately tiny (~200k params — the shipped hey_jarvis head is
1.3 MB): it sees [16,96] embedding windows from the frozen openWakeWord
front-end, so all the acoustic heavy lifting is already done. CPU-trains in
minutes; the GPU is not required at this corpus size.

Rigor notes:
- the train/val split is BY CLIP, not by window — windows from one clip never
  straddle the split, so val measures generalization, not leakage
- exported ONNX is parity-checked against the torch model before writing
- the suggested threshold is chosen on val to hit <0.5% false-accept, then
  reported with its recall so the trade is visible

Usage: python train.py [--data data] [--out hey_nova_v0.1.onnx] [--epochs 60]
"""

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

SEED = 1337
torch.manual_seed(SEED)


class WakeHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(),                      # [B,16,96] -> [B,1536]
            nn.Linear(16 * 96, 128), nn.ReLU(), nn.Dropout(0.3),
            nn.Linear(128, 64), nn.ReLU(),
            nn.Linear(64, 1), nn.Sigmoid(),
        )

    def forward(self, x):
        return self.net(x)


def split_by_clip(clip_ids: np.ndarray, val_frac: float = 0.15):
    rng = np.random.default_rng(SEED)
    clips = np.unique(clip_ids)
    rng.shuffle(clips)
    val_clips = set(clips[:int(len(clips) * val_frac)])
    val_mask = np.isin(clip_ids, list(val_clips))
    return ~val_mask, val_mask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--out", default="hey_nova_v0.1.onnx")
    ap.add_argument("--epochs", type=int, default=60)
    args = ap.parse_args()

    d = np.load(Path(args.data) / "features.npz")
    X, y, clip_ids = d["X"], d["y"], d["clip_ids"]
    tr, va = split_by_clip(clip_ids)
    Xtr, ytr = torch.tensor(X[tr]), torch.tensor(y[tr])
    Xva, yva = torch.tensor(X[va]), torch.tensor(y[va])
    print(f"train {len(ytr)} windows ({int(ytr.sum())} pos) / "
          f"val {len(yva)} windows ({int(yva.sum())} pos)")

    model = WakeHead()
    # class weighting: negatives dominate the window count
    pos_weight = float((ytr == 0).sum() / max(1, (ytr == 1).sum()))
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    best_val, best_state, patience = 1e9, None, 0

    def loss_fn(p, t):
        w = torch.where(t > 0.5, torch.tensor(pos_weight), torch.tensor(1.0))
        return nn.functional.binary_cross_entropy(p.squeeze(1), t, weight=w)

    ds = torch.utils.data.TensorDataset(Xtr, ytr)
    dl = torch.utils.data.DataLoader(ds, batch_size=256, shuffle=True)
    for epoch in range(args.epochs):
        model.train()
        for xb, tb in dl:
            opt.zero_grad()
            loss_fn(model(xb), tb).backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            vl = float(loss_fn(model(Xva), yva))
        if vl < best_val - 1e-4:
            best_val, best_state, patience = vl, {
                k: v.clone() for k, v in model.state_dict().items()}, 0
        else:
            patience += 1
            if patience >= 8:
                print(f"early stop at epoch {epoch + 1}")
                break
        if (epoch + 1) % 10 == 0:
            print(f"  epoch {epoch + 1}: val loss {vl:.4f}")
    model.load_state_dict(best_state)
    model.eval()

    # threshold: lowest false-accept first, then show the recall trade
    with torch.no_grad():
        pv = model(Xva).squeeze(1).numpy()
    yv = yva.numpy()
    print("\nval sweep (threshold: recall / false-accept):")
    suggestion = None
    for th in (0.3, 0.5, 0.7, 0.8, 0.9):
        rec = float((pv[yv == 1] >= th).mean()) if (yv == 1).any() else 0
        fa = float((pv[yv == 0] >= th).mean()) if (yv == 0).any() else 0
        marker = ""
        if suggestion is None and fa < 0.005:
            suggestion, marker = th, "   <- suggested"
        print(f"  {th:.1f}: recall {rec:.3f} / false-accept {fa:.4f}{marker}")

    # export + parity check
    out = Path(args.out)
    torch.onnx.export(model, torch.zeros(1, 16, 96), out,
                      input_names=["embeddings"], output_names=["score"],
                      dynamic_axes={"embeddings": {0: "batch"}}, opset_version=17)
    # the dynamo exporter may externalize weights (.onnx.data) — the browser
    # fetches ONE file, so fold everything back into a self-contained model
    import onnx
    m = onnx.load(out)
    onnx.save(m, out)
    data = Path(str(out) + ".data")
    if data.exists():
        data.unlink()
    import onnxruntime as ort
    sess = ort.InferenceSession(out)
    sample = X[va][:64].astype(np.float32)
    ref = model(torch.tensor(sample)).detach().numpy().reshape(-1)
    got = sess.run(None, {"embeddings": sample})[0].reshape(-1)
    err = float(np.abs(ref - got).max())
    assert err < 1e-4, f"ONNX parity failed: {err}"
    print(f"\n{out} written ({out.stat().st_size / 1e3:.0f} kB), "
          f"onnx-vs-torch max err {err:.2e}, suggested threshold {suggestion}")


if __name__ == "__main__":
    main()
