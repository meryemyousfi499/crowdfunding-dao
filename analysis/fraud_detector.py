#!/usr/bin/env python3
"""
Détection de fraude HORS-CHAÎNE pour la plateforme de crowdfunding.

Lit les événements (CampaignCreated, Contributed, FundsWithdrawn, ...) via web3.py,
les analyse avec Pandas et attribue à chaque campagne un score de risque 0-100 à partir
d'heuristiques explicables. Le script NE modifie RIEN on-chain : il produit un rapport
(console + CSV/JSON) à l'attention de la DAO, qui peut ensuite voter un gel préventif.

Heuristiques :
  H1  Montants répétitifs      : un même montant exact revient très souvent (bots / scripts)
  H2  Pic de contributions     : fort pourcentage des fonds reçus dans une très courte fenêtre
  H3  Rafale d'adresses neuves : nombreuses adresses distinctes ne contribuant qu'une ou deux fois
                                 avec un montant identique (schéma Sybil / wash-funding)
  H4  Concentration            : un seul contributeur apporte l'essentiel des fonds
  H5  Cercle fermé             : le créateur/bénéficiaire a financé des contributeurs (même source)
  H6  Objectif atteint « trop vite et trop rond » (ex. 100 % en < 3 % de la durée)

Usage :
  python analysis/fraud_detector.py                      # RPC + adresses lus dans frontend/contracts.json
  python analysis/fraud_detector.py --rpc http://127.0.0.1:8545 --out analysis/reports
  python analysis/fraud_detector.py --campaign 3 --threshold 50
"""
import argparse
import json
import sys
from pathlib import Path

import pandas as pd
from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
WEI = 10**18

WEIGHTS = {"H1": 25, "H2": 20, "H3": 25, "H4": 15, "H5": 20, "H6": 15}


def load_config(path: Path) -> dict:
    if not path.exists():
        sys.exit(f"Fichier introuvable : {path}. Lancez d'abord le déploiement (npx hardhat run scripts/deploy.js ...).")
    return json.loads(path.read_text(encoding="utf-8"))


def fetch_events(w3: Web3, contract, name: str, from_block: int) -> pd.DataFrame:
    logs = getattr(contract.events, name).get_logs(from_block=from_block)
    rows = []
    for lg in logs:
        row = dict(lg["args"])
        row.update(block=lg["blockNumber"], tx=lg["transactionHash"].hex(), log_index=lg["logIndex"])
        rows.append(row)
    return pd.DataFrame(rows)


def add_timestamps(w3: Web3, df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    cache = {b: w3.eth.get_block(int(b))["timestamp"] for b in df["block"].unique()}
    df = df.copy()
    df["timestamp"] = df["block"].map(cache)
    return df


# --------------------------------------------------------------------------- heuristiques
def h1_repeated_amounts(c: pd.DataFrame):
    if len(c) < 5:
        return 0.0, ""
    top = c["amount"].value_counts()
    share = top.iloc[0] / len(c)
    if top.iloc[0] >= 4 and share >= 0.4:
        return min(1.0, share + 0.2), f"{top.iloc[0]}/{len(c)} contributions ont exactement le même montant ({top.index[0] / WEI:.4f} ETH)"
    return 0.0, ""


def h2_burst(c: pd.DataFrame, window_blocks: int = 30):
    if len(c) < 5:
        return 0.0, ""
    blocks = c["block"].sort_values().to_list()
    total = c["amount"].sum()
    best = 0
    j = 0
    amounts = c.sort_values("block")["amount"].to_list()
    run = 0
    for i, b in enumerate(blocks):
        run += amounts[i]
        while b - blocks[j] > window_blocks:
            run -= amounts[j]
            j += 1
        best = max(best, run)
    share = best / total if total else 0
    if share >= 0.8 and len(c) >= 6 and (max(blocks) - min(blocks)) > 0:
        return min(1.0, share), f"{share:.0%} des fonds reçus en une fenêtre de {window_blocks} blocs"
    return 0.0, ""


def h3_sybil(c: pd.DataFrame):
    g = c.groupby("contributor").agg(n=("amount", "size"), uniq=("amount", "nunique"), amt=("amount", "first"))
    small = g[(g["n"] <= 2) & (g["uniq"] == 1)]
    if len(small) < 5:
        return 0.0, ""
    same = small["amt"].value_counts()
    if same.iloc[0] >= 5 and same.iloc[0] / len(g) >= 0.6:
        return min(1.0, same.iloc[0] / len(g)), (
            f"{same.iloc[0]} adresses distinctes ont contribué 1-2 fois avec le même montant ({same.index[0] / WEI:.4f} ETH) : schéma Sybil probable")
    return 0.0, ""


def h4_concentration(c: pd.DataFrame):
    if c.empty:
        return 0.0, ""
    per = c.groupby("contributor")["amount"].sum().sort_values(ascending=False)
    share = per.iloc[0] / per.sum()
    if share >= 0.7 and len(c) >= 3:
        return min(1.0, share), f"{per.index[0][:10]}… apporte {share:.0%} des fonds"
    return 0.0, ""


def h5_closed_circle(w3: Web3, c: pd.DataFrame, creator: str, beneficiary: str, from_block: int):
    """Un contributeur est-il financé directement par le créateur / bénéficiaire ?
    On inspecte les tx simples (valeur > 0, destinataire = contributeur) dans les blocs de la campagne.
    Sur un nœud public c'est coûteux : limité aux blocs où il y a des contributions."""
    if c.empty:
        return 0.0, ""
    watch = {creator.lower(), beneficiary.lower()}
    contributors = {a.lower() for a in c["contributor"].unique()}
    linked = set()
    lo, hi = int(c["block"].min()), int(c["block"].max())
    for b in range(max(from_block, lo - 20), hi + 1):
        blk = w3.eth.get_block(b, full_transactions=True)
        for tx in blk["transactions"]:
            if tx["from"].lower() in watch and tx.get("to") and tx["to"].lower() in contributors and tx["value"] > 0:
                linked.add(tx["to"].lower())
    if linked:
        r = len(linked) / len(contributors)
        return min(1.0, 0.5 + r), f"{len(linked)} contributeur(s) ont reçu des ETH du créateur/bénéficiaire avant de contribuer"
    return 0.0, ""


def h6_too_fast(c: pd.DataFrame, goal: int, created_ts: int, deadline: int):
    if len(c) < 5 or deadline <= created_ts:
        return 0.0, ""
    cum = c.sort_values(["timestamp", "block"])
    cum = cum.assign(cum=cum["amount"].cumsum())
    hit = cum[cum["cum"] >= goal]
    if hit.empty:
        return 0.0, ""
    frac = (hit.iloc[0]["timestamp"] - created_ts) / (deadline - created_ts)
    if frac <= 0.03:
        return 1.0 - frac * 10, f"objectif atteint après seulement {frac:.1%} de la durée de la campagne"
    return 0.0, ""


# --------------------------------------------------------------------------- orchestration
def analyse(args) -> int:
    cfg = load_config(Path(args.config))
    w3 = Web3(Web3.HTTPProvider(args.rpc or cfg["rpcUrl"]))
    if not w3.is_connected():
        sys.exit("Impossible de se connecter au nœud RPC. Lancez `npx hardhat node` ou fournissez --rpc.")
    core = w3.eth.contract(address=Web3.to_checksum_address(cfg["addresses"]["core"]), abi=cfg["abis"]["core"])
    from_block = int(cfg.get("deployedAtBlock", 0))

    created = add_timestamps(w3, fetch_events(w3, core, "CampaignCreated", from_block))
    contrib = add_timestamps(w3, fetch_events(w3, core, "Contributed", from_block))
    if created.empty:
        print("Aucune campagne trouvée.")
        return 0
    if contrib.empty:
        contrib = pd.DataFrame(columns=["id", "contributor", "amount", "block", "timestamp"])
    contrib = contrib.rename(columns={"contributor": "contributor"})

    results = []
    for _, camp in created.iterrows():
        cid = int(camp["id"])
        if args.campaign is not None and cid != args.campaign:
            continue
        c = contrib[contrib["id"] == cid].copy()
        c["amount"] = c["amount"].astype(object)  # entiers Python : 1 ETH = 1e18 wei déborde int64
        checks = {
            "H1": h1_repeated_amounts(c) if not c.empty else (0, ""),
            "H2": h2_burst(c) if not c.empty else (0, ""),
            "H3": h3_sybil(c) if not c.empty else (0, ""),
            "H4": h4_concentration(c),
            "H5": h5_closed_circle(w3, c, camp["creator"], camp["beneficiary"], from_block) if not args.fast else (0, ""),
            "H6": h6_too_fast(c, int(camp["goal"]), int(camp["timestamp"]), int(camp["deadline"])),
        }
        score = sum(WEIGHTS[k] * v for k, (v, _) in checks.items())
        score = int(min(100, round(score * 100 / sum(WEIGHTS.values()) * 1.6)))  # normalisation : 2-3 signaux => zone rouge
        flags = [f"{k}: {msg}" for k, (v, msg) in checks.items() if v > 0 and msg]
        level = "ÉLEVÉ" if score >= args.threshold else "MODÉRÉ" if score >= args.threshold / 2 else "FAIBLE"
        results.append({
            "campaign_id": cid,
            "creator": camp["creator"],
            "beneficiary": camp["beneficiary"],
            "cid": camp["metadataCid"],
            "goal_eth": camp["goal"] / WEI,
            "raised_eth": sum(int(a) for a in c["amount"]) / WEI if not c.empty else 0.0,
            "contributions": len(c),
            "unique_contributors": int(c["contributor"].nunique()) if not c.empty else 0,
            "risk_score": score,
            "risk_level": level,
            "flags": flags,
            "recommendation": ("Proposer un GEL préventif à la DAO (propose type=1) et examiner manuellement."
                               if level == "ÉLEVÉ" else "Surveiller." if level == "MODÉRÉ" else "RAS"),
        })

    df = pd.DataFrame(results).sort_values("risk_score", ascending=False)
    print("\n=== RAPPORT DE RISQUE ===")
    print(df[["campaign_id", "cid", "raised_eth", "contributions", "unique_contributors", "risk_score", "risk_level"]]
          .to_string(index=False))
    for r in results:
        if r["flags"]:
            print(f"\n[Campagne #{r['campaign_id']}] score {r['risk_score']}/100 ({r['risk_level']})")
            for f in r["flags"]:
                print("  -", f)
            print("  =>", r["recommendation"])

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    df.assign(flags=df["flags"].apply(lambda x: " | ".join(x))).to_csv(out / "fraud_report.csv", index=False, encoding="utf-8-sig")
    (out / "fraud_report.json").write_text(json.dumps(sorted(results, key=lambda r: -r["risk_score"]), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nRapports écrits dans {out}/ (fraud_report.csv, fraud_report.json)")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", default=str(ROOT / "frontend" / "contracts.json"))
    p.add_argument("--rpc", default=None, help="URL du nœud RPC (défaut : celui de contracts.json)")
    p.add_argument("--out", default=str(ROOT / "analysis" / "reports"))
    p.add_argument("--campaign", type=int, default=None, help="n'analyser qu'une campagne")
    p.add_argument("--threshold", type=int, default=50, help="score à partir duquel le risque est ÉLEVÉ")
    p.add_argument("--fast", action="store_true", help="saute H5 (parcours des blocs, lent sur réseau public)")
    sys.exit(analyse(p.parse_args()))


if __name__ == "__main__":
    main()