"""
Couche MACHINE LEARNING de la détection de fraude (en plus des heuristiques explicables).

Principe
  1. Chaque campagne est résumée par 12 caractéristiques numériques (features) calculées à partir des
     contributions on-chain : diversité des adresses, concentration, répétition des montants, rafales,
     vitesse de remplissage, cercle fermé créateur/contributeurs...
  2. Un classifieur Random Forest (scikit-learn) estime la probabilité que le schéma observé soit frauduleux.
  3. Il est ENTRAÎNÉ sur des campagnes SIMULÉES étiquetées (organiques vs. Sybil, wash-funding, baleine/dump),
     car aucun jeu de fraudes réelles étiquetées n'existe sur notre plateforme. Les performances sont mesurées
     par validation croisée (précision, rappel, AUC) et enregistrées dans analysis/reports/ml_metrics.json.

Limite assumée : le modèle apprend les schémas qu'on lui simule. En production, on le ré-entraînerait avec les
campagnes réellement gelées par la DAO (étiquettes réelles).
"""
import json
import math

import numpy as np
import pandas as pd

WEI = 10**18
DAY = 86400
FEATURES = [
    "n_contrib_log", "unique_ratio", "top_amount_share", "top_contributor_share", "amount_cv", "amount_gini",
    "burst_share", "single_shot_ratio", "time_to_goal", "round_ratio", "gap_cv", "creator_circle",
]
FEATURES_FR = {
    "n_contrib_log": "nombre de contributions", "unique_ratio": "part d'adresses distinctes",
    "top_amount_share": "répétition d'un même montant", "top_contributor_share": "concentration sur un contributeur",
    "amount_cv": "dispersion des montants", "amount_gini": "inégalité des montants", "burst_share": "rafale de contributions",
    "single_shot_ratio": "adresses n'ayant contribué qu'une fois", "time_to_goal": "rapidité d'atteinte de l'objectif",
    "round_ratio": "montants ronds", "gap_cv": "régularité des intervalles", "creator_circle": "cercle fermé créateur/contributeurs",
}


def _gini(x):
    x = np.sort(np.asarray(x, dtype=float))
    if x.sum() == 0 or len(x) == 0:
        return 0.0
    n = len(x)
    return float((2 * np.arange(1, n + 1) - n - 1).dot(x) / (n * x.sum()))


def extract(c: pd.DataFrame, goal_wei: int, created_ts: int, deadline: int, circle: float = 0.0, window: int = 30) -> list:
    """Vecteur de caractéristiques d'une campagne (même fonction pour les vraies et les simulées)."""
    if c is None or len(c) == 0:
        return [0.0, 1.0, 0, 0, 0, 0, 0, 0, 1.0, 0, 0, float(circle)]
    amt = np.array([int(a) for a in c["amount"]], dtype=object)
    eth = np.array([a / WEI for a in amt], dtype=float)
    n = len(eth)
    who = c["contributor"].astype(str).str.lower().values
    uniq = len(set(who))
    counts = pd.Series(eth).round(8).value_counts()
    by_who = pd.Series(eth).groupby(who).sum()
    blocks = np.sort(c["block"].astype(int).values)
    j, best = 0, 0
    for i in range(n):  # fenêtre glissante : max de contributions dans `window` blocs
        while blocks[i] - blocks[j] > window:
            j += 1
        best = max(best, i - j + 1)
    gaps = np.diff(blocks)
    cum, ttg = 0.0, 1.0
    order = np.argsort(c["timestamp"].astype(int).values, kind="stable")
    span = max(1, deadline - created_ts)
    for k in order:
        cum += eth[k]
        if cum * WEI >= goal_wei:
            ttg = min(1.0, max(0.0, (int(c["timestamp"].astype(int).values[k]) - created_ts) / span))
            break
    return [
        math.log1p(n), uniq / n, counts.iloc[0] / n, by_who.max() / eth.sum(),
        float(eth.std() / eth.mean()) if eth.mean() > 0 else 0.0, _gini(eth), best / n,
        float((pd.Series(who).value_counts() == 1).sum() / uniq), ttg,
        float(np.mean(np.isclose((eth * 10) % 1, 0, atol=1e-9) | np.isclose((eth * 10) % 1, 1, atol=1e-9))),
        float(gaps.std() / gaps.mean()) if len(gaps) > 1 and gaps.mean() > 0 else 0.0, float(circle),
    ]


# ------------------------------------------------------------------ simulation de campagnes étiquetées
def _frame(rng, amounts, who, blocks, ts):
    return pd.DataFrame({"amount": [int(a * WEI) for a in amounts], "contributor": who, "block": blocks, "timestamp": ts})


def _organic(rng, hard=False):
    dur = int(rng.integers(14, 31)) * DAY
    n = int(rng.integers(5, 60))
    amounts = np.round(rng.lognormal(math.log(0.5), 1.0, n), 4) + 0.001
    pool = [f"0x{rng.integers(0, 10**12):012x}" for _ in range(max(2, int(n * rng.uniform(0.5, 1.0))))]
    who = [pool[i] for i in rng.integers(0, len(pool), n)]
    t = np.sort(rng.beta(rng.uniform(0.7, 1.5), rng.uniform(0.7, 1.5), n)) * dur  # étalé, parfois plus dense au début/à la fin
    blocks = (np.cumsum(rng.exponential(250, n)) + 100).astype(int)
    if hard:  # cas difficiles « innocents » qui ressemblent à de la fraude
        r = rng.random()
        if r < 0.25:
            amounts[0] = amounts.sum() * rng.uniform(0.3, 0.6)                       # baleine légitime
        elif r < 0.5:
            k = int(n * rng.uniform(0.3, 0.6)); blocks[:k] = blocks[0] + rng.integers(0, 40, k); blocks.sort()  # viralité
        elif r < 0.75:
            k = int(n * rng.uniform(0.3, 0.6)); amounts[:k] = rng.choice([0.5, 1.0, 0.1]); t = np.sort(rng.uniform(0, 0.4, n)) * dur  # montants ronds populaires
        else:
            pool = [f"0x{rng.integers(0, 10**12):012x}" for _ in range(n)]; who = pool; t = np.sort(rng.uniform(0, 0.25, n)) * dur  # foule d'adresses neuves, début de campagne
    goal = amounts.sum() * rng.uniform(0.8, 3.0)
    return _frame(rng, amounts, who, blocks, t.astype(int) + 1_000), goal, dur, 0.0


def _fraud(rng, kind):
    dur = int(rng.integers(7, 31)) * DAY
    if kind == "sybil":
        n = int(rng.integers(8, 45)); a = float(rng.choice([0.5, 1.0, 2.0, 0.25, 0.37]))
        amounts = np.full(n, a) + (rng.random(n) < 0.15) * rng.uniform(0.01, 0.2, n)
        who = [f"0x{rng.integers(0, 10**12):012x}" for _ in range(n)]
        blocks = (rng.integers(0, int(rng.integers(5, 60)), n) + 500); circle = float(rng.random() < 0.3)
        t = np.sort(rng.uniform(0, 0.08, n)) * dur
    elif kind == "wash":
        n = int(rng.integers(5, 25)); a = float(rng.choice([1.0, 2.5, 5.0, 3.0]))
        pool = [f"0x{rng.integers(0, 10**12):012x}" for _ in range(int(rng.integers(2, 5)))]
        amounts = np.full(n, a); who = [pool[i] for i in rng.integers(0, len(pool), n)]
        blocks = np.sort(rng.integers(0, int(rng.integers(20, 200)), n)) + 500; circle = 1.0
        t = np.sort(rng.uniform(0, 0.12, n)) * dur
    else:  # baleine / dump : un seul gros contributeur, quelques petits en alibi
        n = int(rng.integers(4, 15)); amounts = np.round(rng.uniform(0.01, 0.4, n), 3) + 0.001
        amounts[0] = amounts.sum() * rng.uniform(4, 15)
        who = [f"0x{rng.integers(0, 10**12):012x}" for _ in range(n)]
        blocks = np.sort(rng.integers(0, int(rng.integers(10, 80)), n)) + 500; circle = float(rng.random() < 0.5)
        t = np.sort(rng.uniform(0, 0.1, n)) * dur
    if rng.random() < 0.45:  # fraude FURTIVE : bruit organique, montants légèrement variés, étalement dans le temps
        m = int(len(amounts) * rng.uniform(0.4, 1.2)) + 1
        extra = np.round(rng.lognormal(math.log(0.4), 0.9, m), 4) + 0.001
        amounts = np.concatenate([amounts * rng.uniform(0.85, 1.15, len(amounts)), extra])
        who = list(who) + [f"0x{rng.integers(0, 10**12):012x}" for _ in range(m)]
        blocks = np.concatenate([blocks, (np.cumsum(rng.exponential(200, m)) + 400).astype(int)])
        t = np.concatenate([t, rng.uniform(0, 0.5, m) * dur])
        circle = circle if rng.random() < 0.6 else 0.0
    goal = amounts.sum() * rng.uniform(0.7, 1.1)
    return _frame(rng, amounts, who, blocks, t.astype(int) + 1_000), goal, dur, circle


def simulate(n_normal=600, n_each_fraud=100, seed=7):
    rng = np.random.default_rng(seed)
    X, y, kinds = [], [], []
    for i in range(n_normal):
        c, goal, dur, circ = _organic(rng, hard=(i % 5 < 2))
        X.append(extract(c, int(goal * WEI), 1_000, 1_000 + dur, circ)); y.append(0); kinds.append("normal")
    for kind in ("sybil", "wash", "whale"):
        for _ in range(n_each_fraud):
            c, goal, dur, circ = _fraud(rng, kind)
            X.append(extract(c, int(goal * WEI), 1_000, 1_000 + dur, circ)); y.append(1); kinds.append(kind)
    return np.array(X, dtype=float), np.array(y), np.array(kinds)


# ------------------------------------------------------------------ modèle
class FraudModel:
    def __init__(self, seed=7):
        from sklearn.ensemble import RandomForestClassifier
        self.seed = seed
        self.clf = RandomForestClassifier(n_estimators=250, max_depth=7, min_samples_leaf=3, class_weight="balanced", random_state=seed)
        self.metrics = {}

    def fit(self):
        from sklearn.metrics import precision_recall_fscore_support, roc_auc_score
        from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split
        X, y, kinds = simulate(seed=self.seed)
        cv = StratifiedKFold(5, shuffle=True, random_state=self.seed)
        proba = cross_val_predict(self.clf, X, y, cv=cv, method="predict_proba")[:, 1]
        pred = (proba >= 0.5).astype(int)
        p, r, f, _ = precision_recall_fscore_support(y, pred, average="binary")
        Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, stratify=y, random_state=self.seed)
        self.clf.fit(Xtr, ytr)
        ho = self.clf.predict_proba(Xte)[:, 1]
        # Généralisation : on retire UN type de fraude de l'entraînement et on mesure s'il est quand même détecté.
        from sklearn.base import clone
        loo = {}
        for k in ("sybil", "wash", "whale"):
            m = clone(self.clf).fit(X[kinds != k][y[kinds != k] >= 0], y[kinds != k])
            loo[k] = round(float((m.predict_proba(X[kinds == k])[:, 1] >= 0.5).mean()), 3)
        self.clf.fit(X, y)
        self.mu, self.sd = X[y == 0].mean(0), X[y == 0].std(0) + 1e-9
        self.metrics = {
            "training_set": {"campagnes_normales": int((y == 0).sum()), "campagnes_frauduleuses_simulees": int((y == 1).sum()), "features": FEATURES},
            "cross_validation_5_fold": {"precision": round(float(p), 3), "recall": round(float(r), 3), "f1": round(float(f), 3), "roc_auc": round(float(roc_auc_score(y, proba)), 3)},
            "holdout_25_percent": {"roc_auc": round(float(roc_auc_score(yte, ho)), 3), "accuracy": round(float(((ho >= .5) == yte).mean()), 3)},
            "rappel_sur_un_type_de_fraude_jamais_vu": loo,
            "feature_importance": {k: round(float(v), 3) for k, v in sorted(zip(FEATURES, self.clf.feature_importances_), key=lambda t: -t[1])},
            "limite": "entraîné sur des campagnes simulées : à ré-entraîner avec les gels réellement votés par la DAO",
        }
        return self

    def score(self, vec):
        """-> (probabilité de fraude 0..1, [3 facteurs explicatifs])"""
        v = np.array(vec, dtype=float).reshape(1, -1)
        p = float(self.clf.predict_proba(v)[0, 1])
        z = (v[0] - self.mu) / self.sd
        contrib = self.clf.feature_importances_ * np.abs(z)
        top = [FEATURES_FR[FEATURES[i]] for i in np.argsort(-contrib)[:3]]
        return p, top

    def save_metrics(self, path):
        path.write_text(json.dumps(self.metrics, indent=2, ensure_ascii=False), encoding="utf-8")