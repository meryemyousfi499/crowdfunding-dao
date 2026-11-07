/* CrowdFund DAO – dApp (Ethers v6 + MetaMask). Aucune dépendance de build. */
"use strict";

const { ethers } = window;
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");

// ------------------------------------------------------------------ état global
const S = {
  seq: 0,
  cfg: null,           // contracts.json
  read: null,          // provider lecture seule (RPC)
  web3: null,          // BrowserProvider (MetaMask)
  signer: null,
  account: null,
  c: {},               // contrats (lecture)
  w: {},               // contrats (écriture, avec signer)
  fraud: {},           // id -> rapport de risque (analysis/reports/fraud_report.json)
  now: Math.floor(Date.now() / 1000),
  meta: new Map(),
  filters: { q: "", status: ["Active", "Successful"], cat: "", sort: "new", page: 1 },
};
const STATUS = ["Active", "Successful", "Failed", "Canceled"];
const STATUS_FR = ["En cours", "Réussie", "Échouée", "Annulée / gelée"];
const PSTATE_FR = ["En attente", "Vote en cours", "Rejetée", "Adoptée", "En timelock", "Exécutée", "Expirée"];
const PAGE_SIZE = 9;
const CATS = ["Éducation", "Technologie", "Environnement", "Santé", "Art & culture", "Communauté", "Finance"];

// Messages lisibles pour les erreurs personnalisées des contrats
const ERR_FR = {
  CampaignNotActive: "La campagne n'est plus active.", ContributionTooLow: "Contribution inférieure au minimum (0,001 ETH).",
  SelfFunding: "Le créateur / bénéficiaire ne peut pas financer sa propre campagne.", NotRefundable: "Cette campagne n'est pas remboursable.",
  NothingToRefund: "Rien à rembourser pour ce compte.", NotBeneficiary: "Réservé au bénéficiaire.", NoTrancheAvailable: "Aucune tranche validée par la DAO à retirer.",
  NotYetDelivered: "Les jetons se débloquent après le versement de toutes les tranches.", NothingToClaim: "Aucun jeton à débloquer.",
  BelowThreshold: "Solde de CFD insuffisant (au snapshot) pour proposer.", AlreadyOpen: "Une proposition de ce type est déjà ouverte pour cette campagne.",
  NoVotingPower: "Aucun pouvoir de vote au snapshot de cette proposition.", AlreadyVoted: "Vous avez déjà voté.", NotActive: "Le vote n'est pas ouvert.",
  WrongState: "Action impossible dans l'état actuel de la proposition.", TimelockNotElapsed: "Le timelock n'est pas encore écoulé.",
  InvalidParameters: "Paramètres invalides.", EnforcedPause: "La plateforme est en pause (circuit breaker).", InsufficientUnlockedBalance: "Jetons verrouillés : transfert impossible.",
  InvalidStatus: "Statut de campagne incompatible.", NoFees: "Aucun frais à transférer.", GoalNotReached: "Objectif non atteint.",
};

// ------------------------------------------------------------------ utilitaires
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const eth = (w, d = 4) => { const n = Number(ethers.formatEther(w)); return n.toLocaleString("fr-FR", { maximumFractionDigits: d }); };
const cfd = (w) => Number(ethers.formatEther(w)).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const pct = (a, b) => (b > 0n ? Math.min(100, Number((a * 10000n) / b) / 100) : 0);
const safeUrl = (u) => (/^(https?:\/\/|ipfs:\/\/)/i.test(u || "") ? u.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/") : "");
function dur(sec) {
  if (sec <= 0) return "terminé";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : `${m} min ${sec % 60} s`;
}
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind; t.textContent = msg;
  $("#toasts").append(t); setTimeout(() => t.remove(), kind === "bad" ? 9000 : 5000);
}
function decodeErr(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "Transaction refusée dans MetaMask.";
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  try {
    if (data && typeof data === "string" && data.length >= 10) {
      for (const k of ["core", "dao", "token", "treasury"]) {
        const p = S.c[k]?.interface.parseError(data);
        if (p) return ERR_FR[p.name] || p.name;
      }
    }
  } catch { /* ignore */ }
  const m = e?.revert?.name || e?.reason || e?.shortMessage || e?.message || String(e);
  return ERR_FR[m] || m;
}
async function tx(label, fn) {
  if (!S.signer) { toast("Connectez d'abord MetaMask.", "bad"); return false; }
  S.busy = true;
  try {
    toast(label + " – confirmez dans MetaMask…");
    const t = await fn();
    toast("Transaction envoyée, en attente de confirmation…");
    await t.wait();
    toast(label + " : confirmé ✔", "ok");
    await refreshNow();
    route();
    return true;
  } catch (e) { console.error(e); toast(decodeErr(e), "bad"); return false; }
  finally { S.busy = false; }
}
async function refreshNow() {
  try {
    const p = await S.read.send("eth_getBlockByNumber", ["pending", false]);
    S.now = parseInt(p.timestamp, 16);
  } catch {
    try { S.now = (await S.read.getBlock("latest")).timestamp; } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ métadonnées (IPFS)
async function loadMeta(cid) {
  if (S.meta.has(cid)) return S.meta.get(cid);
  let m = { title: "Campagne " + short(cid), description: "", category: "Communauté", image: "" };
  try {
    if (cid.startsWith("file:")) m = await (await fetch(`metadata/${encodeURIComponent(cid.slice(5))}.json`)).json();
    else if (cid.startsWith("local:")) m = JSON.parse(localStorage.getItem("meta:" + cid) || "null") || m;
    else {
      const gw = localStorage.getItem("gateway") || "https://ipfs.io/ipfs/";
      m = await (await fetch(gw + cid)).json();
    }
  } catch (e) { console.warn("métadonnées indisponibles", cid, e); }
  S.meta.set(cid, m); return m;
}
async function uploadMeta(obj) {
  const jwt = localStorage.getItem("pinataJwt");
  if (jwt) {
    const r = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
      body: JSON.stringify({ pinataContent: obj }),
    });
    if (!r.ok) throw new Error("Pinata: " + r.status);
    return (await r.json()).IpfsHash;
  }
  // Repli de démo : stockage local au navigateur (visible uniquement ici !)
  const id = "local:" + ethers.id(JSON.stringify(obj)).slice(2, 18);
  localStorage.setItem("meta:" + id, JSON.stringify(obj));
  return id;
}

// ------------------------------------------------------------------ connexion
async function init() {
  try { S.cfg = await (await fetch("contracts.json", { cache: "no-store" })).json(); }
  catch { app.innerHTML = `<div class="alert bad">Fichier <code>contracts.json</code> introuvable. Déployez d'abord les contrats : <code>npx hardhat run scripts/deploy.js --network localhost</code>.</div>`; return; }
  S.read = new ethers.JsonRpcProvider(S.cfg.rpcUrl, S.cfg.chainId, { staticNetwork: true });
  bind(S.read);
  try { S.fraud = Object.fromEntries((await (await fetch("../analysis/reports/fraud_report.json", { cache: "no-store" })).json()).map((r) => [r.campaign_id, r])); } catch { S.fraud = {}; }
  $("#connect").onclick = connect;
  $("#settings").onclick = openSettings;
  if (DEV && S.cfg.chainId === 31337) { await initDev(); }
  else if (window.ethereum) {
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
    const accts = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
    if (accts.length) await connect(true);
  }
  window.addEventListener("hashchange", route);
  await refreshNow();
  route();
  // Tout est automatique (robot) : la page se met à jour seule, sauf pendant une saisie ou un dialogue ouvert.
  setInterval(async () => {
    const el = document.activeElement, typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.id !== "devAcct";
    if (document.hidden || typing || $("#dlg")?.open || S.busy || /^#\/(create)/.test(location.hash)) return;
    await refreshNow().catch(() => {});
    route();
  }, 4000);
}
function bind(runner) {
  for (const k of ["token", "core", "dao", "treasury"]) S.c[k] = new ethers.Contract(S.cfg.addresses[k], S.cfg.abis[k], runner);
}
// MODE TEST LOCAL (?dev=1) : utilise les comptes déverrouillés du nœud Hardhat, sans MetaMask ni pop-up.
const DEV = new URLSearchParams(location.search).has("dev");
async function initDev() {
  const sel = $("#devAcct"), accts = await S.read.send("eth_accounts", []);
  const role = (i) => (i === 0 ? "déployeur" : i >= 17 ? "multisig" : i === 1 ? "créateur ?" : "");
  sel.innerHTML = accts.map((a, i) => `<option value="${a}">#${i} ${short(a)} ${role(i)}</option>`).join("");
  sel.classList.remove("hidden"); $("#connect").classList.add("hidden");
  const n = $("#net"); n.textContent = "MODE TEST · " + S.cfg.network; n.classList.remove("hidden");
  const use = async (addr) => {
    S.signer = await S.read.getSigner(addr); S.account = addr;
    for (const k of Object.keys(S.c)) S.w[k] = S.c[k].connect(S.signer);
  };
  sel.onchange = async () => { await use(sel.value); localStorage.setItem("devAcct", sel.value); route(); };
  const saved = localStorage.getItem("devAcct");
  if (saved && accts.includes(saved)) sel.value = saved;
  await use(sel.value);
}
async function connect(silent) {
  if (!window.ethereum) { toast("MetaMask non détecté. Installez l'extension https://metamask.io", "bad"); return; }
  try {
    S.web3 = new ethers.BrowserProvider(window.ethereum);
    await S.web3.send("eth_requestAccounts", []);
    const net = await S.web3.getNetwork();
    if (Number(net.chainId) !== S.cfg.chainId) {
      await switchChain();
      S.web3 = new ethers.BrowserProvider(window.ethereum);
    }
    S.signer = await S.web3.getSigner();
    S.account = await S.signer.getAddress();
    for (const k of Object.keys(S.c)) S.w[k] = S.c[k].connect(S.signer);
    $("#connect").textContent = short(S.account);
    const n = $("#net"); n.textContent = S.cfg.network + " · " + S.cfg.chainId; n.classList.remove("hidden");
    if (silent !== true) toast("Connecté : " + short(S.account), "ok");
    route();
  } catch (e) { console.error(e); if (silent !== true) toast(decodeErr(e), "bad"); }
}
async function switchChain() {
  const hex = "0x" + S.cfg.chainId.toString(16);
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
  catch (e) {
    if (e.code === 4902 || e?.data?.originalError?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: S.cfg.chainId === 31337 ? "Hardhat Local" : S.cfg.network, rpcUrls: [S.cfg.rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
      });
    } else throw e;
  }
}
function openSettings() {
  const d = $("#dlg"), f = $("#dlgForm");
  f.innerHTML = `<h3>Paramètres IPFS</h3>
    <p class="muted small">Les métadonnées (titre, description, image) sont stockées sur IPFS ; seul le hash (CID) est écrit on-chain.
    Sans jeton Pinata, un repli local est utilisé (visible uniquement dans ce navigateur).</p>
    <label class="f" for="jwt">Jeton Pinata (JWT)</label><input id="jwt" type="password" autocomplete="off" value="${esc(localStorage.getItem("pinataJwt") || "")}">
    <label class="f" for="gw">Passerelle de lecture</label><input id="gw" value="${esc(localStorage.getItem("gateway") || "https://ipfs.io/ipfs/")}">
    <div id="ipfsTest" class="small muted" style="min-height:1.4em;margin-top:8px"></div>
    <div class="actions"><button value="save" class="primary">Enregistrer</button><button value="test" class="ghost">Tester la connexion</button><button value="cancel">Fermer</button></div>`;
  f.onsubmit = (e) => {
    if (e.submitter?.value === "test") { e.preventDefault(); testPinata($("#jwt").value.trim(), $("#gw").value.trim() || "https://ipfs.io/ipfs/"); return; }
    if (e.submitter?.value === "save") { localStorage.setItem("pinataJwt", $("#jwt").value.trim()); localStorage.setItem("gateway", $("#gw").value.trim() || "https://ipfs.io/ipfs/"); toast("Enregistré", "ok"); } };
  d.showModal();
}
// Test réel de Pinata : 1) authentification 2) épinglage d'un petit JSON 3) relecture via la passerelle.
async function testPinata(jwt, gw) {
  const out = $("#ipfsTest"), say = (t, bad) => { out.textContent = t; out.style.color = bad ? "var(--bad, #c0392b)" : ""; };
  if (!jwt) return say("Collez d'abord votre jeton Pinata (JWT).", true);
  try {
    say("1/3 Authentification…");
    const a = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: "Bearer " + jwt } });
    if (!a.ok) return say(`✗ Jeton refusé par Pinata (HTTP ${a.status}). Vérifiez le JWT (droit « pinJSONToIPFS »).`, true);
    say("2/3 Épinglage d'un JSON de test…");
    const p = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt }, body: JSON.stringify({ pinataContent: { test: "CrowdFund DAO", t: Date.now() } }) });
    if (!p.ok) return say(`✗ Épinglage refusé (HTTP ${p.status}).`, true);
    const cid = (await p.json()).IpfsHash;
    say(`3/3 Relecture de ${cid} via la passerelle…`);
    const g = await fetch(gw + cid);
    say(g.ok ? `✓ Tout fonctionne. CID de test : ${cid}` : `✓ Pinata OK (CID ${cid}) mais la passerelle répond HTTP ${g.status} : réessayez dans une minute ou changez de passerelle.`, !g.ok);
  } catch (e) { say("✗ Erreur réseau : " + (e.message || e), true); }
}

// ------------------------------------------------------------------ données
async function loadCampaigns() {
  const n = Number(await S.c.core.campaignCount());
  const list = await Promise.all(Array.from({ length: n }, async (_, id) => {
    const [c, st] = await Promise.all([S.c.core.getCampaign(id), S.c.core.effectiveStatus(id)]);
    const meta = await loadMeta(c.metadataCid);
    return { id, c, st: Number(st), meta };
  }));
  return list;
}
const covers = ["#0b6e5c,#2fc2a1", "#264653,#2a9d8f", "#6a4c93,#8ac926", "#c0392b,#f2a900", "#1d3557,#457b9d"];
function coverStyle(x) {
  const img = safeUrl(x.meta.image);
  const g = covers[x.id % covers.length];
  return img ? `background-image:linear-gradient(transparent 40%,rgba(0,0,0,.55)),url('${esc(img)}')` : `background-image:linear-gradient(135deg,${g})`;
}
function riskBadge(id) {
  const r = S.fraud[id];
  if (!r || r.risk_level === "FAIBLE") return "";
  return `<span class="pill ${r.risk_level === "ÉLEVÉ" ? "bad" : "warn"}" title="${esc(r.flags.join(" | "))}">⚠ Risque IA ${esc(r.risk_level)} (${esc(r.risk_score)})</span>`;
}
const statusPill = (st) => `<span class="pill ${["", "ok", "bad", "warn"][st]}">${STATUS_FR[st]}</span>`;


// ------------------------------------------------------------------ blocs d'affichage réutilisables
function trancheRows(c) {
  return Array.from({ length: Number(c.milestones) }, (_, i) => {
    const done = i < Number(c.tranchesWithdrawn), appr = i < Number(c.tranchesApproved);
    return `<li class="tr"><span class="dot ${done ? "done" : appr ? "appr" : ""}">${done ? "✓" : i + 1}</span><span>Tranche ${i + 1}</span>
      <span class="pill ${done ? "ok" : appr ? "warn" : ""}">${done ? "Versée" : appr ? "Validée : versement automatique" : "En attente du vote"}</span></li>`;
  }).join("");
}
const tile = (label, value, sub = "") => `<div class="tile"><small>${label}</small><b>${value}</b>${sub ? `<em>${sub}</em>` : ""}</div>`;
function propCard(i, p, s) {
  const f = Number(p.forVotes), a = Number(p.againstVotes), tot = f + a || 1;
  const cls = s === 5 ? "ok" : s === 2 || s === 6 ? "bad" : s === 1 ? "warn" : "";
  return `<div class="panel prop2">
    <div class="row"><div><span class="muted small">Proposition n°${i}</span><div class="prop-title">${p.kind === 0n ? "✔ Valider une tranche" : "❄ Geler la campagne"}</div></div>
      <span class="pill ${cls}">${PSTATE_FR[s]}</span></div>
    <p style="margin:6px 0">${esc(p.description)}</p>
    <div class="vote"><div class="y" style="width:${(f / tot) * 100}%"></div><div class="n" style="width:${(a / tot) * 100}%"></div></div>
    <div class="row small muted"><span>Pour : <b>${f}</b></span><span>${p.voters} votant(s)</span><span>Contre : <b>${a}</b></span></div>
    <div class="actions" style="margin:4px 0 0"><a class="btn ${s === 1 ? "primary" : ""}" href="#/dao">${s === 1 ? "Voter" : "Voir le détail"} →</a></div></div>`;
}

// ------------------------------------------------------------------ routeur
function route() {
  S.seq++;
  const h = location.hash.replace(/^#/, "") || "/";
  const [, p1, p2] = h.split("/");
  if (h !== S.cur) { S.last = S.cur; S.cur = h; }   // mémorise la page précédente (pour le lien « retour »)
  const active = p1 === "treasury" ? "dao" : p1 === "create" ? "mine" : p1 === "campaign" ? (/^\/(mine|contribs|account|dao)/.test(S.last || "") ? S.last.split("/")[1] : "home") : (p1 || "home");
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === active));
  const fn = p1 === "campaign" ? () => viewCampaign(Number(p2)) : p1 === "create" ? viewCreate : p1 === "mine" ? viewMine : p1 === "contribs" ? viewContribs : p1 === "dao" ? viewDao : p1 === "treasury" ? viewTreasury : p1 === "account" ? viewAccount : viewHome;
  Promise.resolve(fn()).catch((e) => { console.error(e); app.innerHTML = `<div class="alert bad">Erreur de lecture de la blockchain : ${esc(e.shortMessage || e.message)}.<br>Le nœud local est-il lancé (<code>npx hardhat node</code>) ?</div>`; });
}

// ------------------------------------------------------------------ vue : accueil
async function viewHome() {
  const my = S.seq;
  const all = await loadCampaigns();
  const totalRaised = all.reduce((s, x) => s + x.c.raised, 0n);
  const active = all.filter((x) => x.st === 0).length;
  const f = S.filters;
  let list = all.filter((x) => f.status.includes(STATUS[x.st]) &&
    (!f.cat || x.meta.category === f.cat) &&
    (!f.q || (x.meta.title + x.meta.description).toLowerCase().includes(f.q.toLowerCase())));
  list.sort((a, b) => f.sort === "raised" ? Number(b.c.raised - a.c.raised) : f.sort === "end" ? Number(a.c.deadline - b.c.deadline) :
    f.sort === "progress" ? pct(b.c.raised, b.c.goal) - pct(a.c.raised, a.c.goal) : b.id - a.id);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  f.page = Math.min(f.page, pages);
  const slice = list.slice((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE);
  const catCount = (c) => all.filter((x) => x.meta.category === c).length;

  if (my !== S.seq) return;
  app.innerHTML = `
  <section class="hero">
    <div><h1>Financez des projets, gouvernez ensemble.</h1>
    <p>Chaque contribution en ETH vous donne des jetons de gouvernance <b>CFD</b>. Les fonds sont libérés par tranches seulement si la DAO valide les étapes — et vous êtes remboursé si la campagne échoue.</p></div>
    <div class="stats">
      <div class="stat"><b>${all.length}</b><span>campagnes</span></div>
      <div class="stat"><b>${active}</b><span>en cours</span></div>
      <div class="stat"><b>${eth(totalRaised, 2)} ETH</b><span>levés au total</span></div>
      <div class="stat"><b>${S.cfg.params.quorumVoters}</b><span>votants min. (quorum DAO)</span></div>
    </div>
  </section>
  <div class="layout">
    <aside class="panel filters" aria-label="Filtres">
      <h3>Recherche</h3><input id="q" type="search" placeholder="Titre, mot-clé…" value="${esc(f.q)}">
      <h3>Statut</h3>
      ${STATUS.map((s, i) => `<label><input type="checkbox" data-st="${s}" ${f.status.includes(s) ? "checked" : ""}> ${STATUS_FR[i]}</label>`).join("")}
      <h3>Catégorie</h3>
      <label><input type="radio" name="cat" value="" ${!f.cat ? "checked" : ""}> Toutes (${all.length})</label>
      ${CATS.map((c) => `<label><input type="radio" name="cat" value="${c}" ${f.cat === c ? "checked" : ""}> ${c} (${catCount(c)})</label>`).join("")}
      <h3>Trier par</h3>
      <select id="sort">${[["new", "Plus récentes"], ["raised", "Montant levé"], ["progress", "Progression"], ["end", "Fin proche"]].map(([v, l]) => `<option value="${v}" ${f.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <div class="actions"><button id="clear" class="ghost">Réinitialiser</button></div>
    </aside>
    <section>
      <p class="muted small" aria-live="polite">${list.length} résultat(s) sur ${all.length}</p>
      ${slice.length ? `<div class="grid">${slice.map(cardHtml).join("")}</div>` : `<div class="panel">Aucune campagne ne correspond. Assouplissez les filtres ou <a href="#/create">lancez la vôtre</a>.</div>`}
      <div class="pager">${Array.from({ length: pages }, (_, i) => `<button data-p="${i + 1}" class="${i + 1 === f.page ? "on" : ""}">${i + 1}</button>`).join("")}</div>
    </section>
  </div>`;
  const redo = () => { f.page = 1; viewHome(); };
  $("#q").oninput = (e) => { f.q = e.target.value; clearTimeout(viewHome.t); viewHome.t = setTimeout(async () => { await viewHome(); $("#q").focus(); $("#q").setSelectionRange(99, 99); }, 250); };
  app.querySelectorAll("[data-st]").forEach((el) => el.onchange = () => { f.status = [...app.querySelectorAll("[data-st]:checked")].map((x) => x.dataset.st); redo(); });
  app.querySelectorAll("[name=cat]").forEach((el) => el.onchange = () => { f.cat = el.value; redo(); });
  $("#sort").onchange = (e) => { f.sort = e.target.value; redo(); };
  $("#clear").onclick = () => { Object.assign(f, { q: "", status: ["Active", "Successful"], cat: "", sort: "new", page: 1 }); viewHome(); };
  app.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => { f.page = Number(b.dataset.p); viewHome(); });
}
function cardHtml(x) {
  const p = pct(x.c.raised, x.c.goal);
  const left = Number(x.c.deadline) - S.now;
  return `<a class="card" href="#/campaign/${x.id}">
    <div class="cover" style="${coverStyle(x)}">${statusPill(x.st)} <span class="pill">${esc(x.meta.category)}</span></div>
    <div class="body"><h3>${esc(x.meta.title)}</h3><p>${esc(x.meta.description)}</p>
      <div class="meter" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></div>
      <div class="row"><b>${eth(x.c.raised, 2)} ETH</b><span class="muted">sur ${eth(x.c.goal, 2)} · ${p.toFixed(0)} %</span></div>
      <div class="row muted"><span>${x.st === 0 ? "⏳ " + dur(left) : STATUS_FR[x.st]}</span><span>${x.c.milestones} tranche(s)</span></div>
      ${riskBadge(x.id)}</div></a>`;
}

// ------------------------------------------------------------------ vue : détail
async function viewCampaign(id) {
  const my = S.seq;
  const n = Number(await S.c.core.campaignCount());
  if (!(id >= 0 && id < n)) { app.innerHTML = `<div class="alert bad">Campagne introuvable.</div>`; return; }
  const [c, st] = await Promise.all([S.c.core.getCampaign(id), S.c.core.effectiveStatus(id).then(Number)]);
  const meta = await loadMeta(c.metadataCid);
  const me = S.account;
  const from = S.last || "/";   // d'où vient l'utilisateur ? (liste, Mes projets, Mon compte, Gouvernance)
  const back = from.startsWith("/mine") ? ["#/mine", "Mes projets"] : from.startsWith("/contribs") ? ["#/contribs", "Mes contributions"] : from.startsWith("/account") ? ["#/account", "Mon compte"]
    : from.startsWith("/dao") ? ["#/dao", "Gouvernance"] : ["#/", "Toutes les campagnes"];
  const [mine, myLocked, nProps] = await Promise.all([
    me ? S.c.core.contributionOf(id, me) : 0n, me ? S.c.core.lockedTokensOf(id, me) : 0n, S.c.dao.proposalCount()]);
  const tranches = await Promise.all(Array.from({ length: Number(c.milestones) }, (_, i) => S.c.core.trancheAmount(id, i)));
  const props = [];
  for (let i = 0; i < Number(nProps); i++) {
    const p = await S.c.dao.getProposal(i);
    if (Number(p.campaignId) === id) props.push({ i, p, s: Number(await S.c.dao.state(i)) });
  }
  const p = pct(c.raised, c.goal), left = Number(c.deadline) - S.now;
  const isBen = me && me.toLowerCase() === c.beneficiary.toLowerCase();
  const risk = S.fraud[id];
  const canRefund = (st === 2 || st === 3) && mine > 0n;
  const canWithdraw = isBen && st === 1 && c.tranchesWithdrawn < c.tranchesApproved;
  const canClaim = st === 1 && c.tranchesWithdrawn === c.milestones && myLocked > 0n;
  const contributable = st === 0 && left > 0;

  if (my !== S.seq) return;
  app.innerHTML = `
  <p><a href="${back[0]}">← ${back[1]}</a></p>
  <div class="cols"><div>
    <div class="panel"><div class="cover" style="${coverStyle({ id, meta })};border-radius:10px;height:180px">${statusPill(st)} <span class="pill">${esc(meta.category)}</span></div>
      <h1>${esc(meta.title)}</h1>
      <p style="white-space:pre-wrap">${esc(meta.description)}</p>
      <p class="muted small">Créateur <span class="mono">${esc(c.creator)}</span><br>Bénéficiaire <span class="mono">${esc(c.beneficiary)}</span><br>Métadonnées IPFS <span class="mono">${esc(c.metadataCid)}</span></p></div>
    ${risk && risk.risk_level !== "FAIBLE" ? `<div class="alert ${risk.risk_level === "ÉLEVÉ" ? "bad" : "warn"}"><b>⚠ Analyse IA hors-chaîne : risque ${esc(risk.risk_level)} (${esc(risk.risk_score)}/100)</b><ul>${risk.flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <button id="propFreeze" class="danger">Proposer un gel à la DAO</button></div>` : ""}
    <h2>Déblocage par tranches (milestones)</h2>
    <ul class="trl big">${tranches.map((t, i) => {
      const done = i < Number(c.tranchesWithdrawn), appr = i < Number(c.tranchesApproved);
      return `<li class="tr"><span class="dot ${done ? "done" : appr ? "appr" : ""}">${done ? "✓" : i + 1}</span><div style="flex:1"><b>Tranche ${i + 1}</b> — ${eth(t)} ETH <span class="muted small">(−2 % frais)</span></div><span class="pill ${done ? "ok" : appr ? "warn" : ""}">${done ? "Versée" : appr ? "Validée par la DAO" : "En attente de vote"}</span></li>`;
    }).join("")}</ul>
    <h2>Gouvernance de ce projet</h2>
    <p class="muted">Les tranches sont débloquées par un vote des détenteurs de CFD. Une proposition adoptée attend la fin du timelock avant d'être exécutée.</p>
    ${props.length ? props.map(({ i, p, s }) => propCard(i, p, s)).join("") : `<div class="panel muted">Aucune proposition pour l'instant.</div>`}
    ${st <= 1 ? `<div class="actions"><button id="propTr" class="primary">Proposer la validation d'une tranche</button><button id="propFz">Proposer un gel</button></div>` : ""}
  </div>
  <aside class="panel" style="position:sticky;top:80px">
    <div class="meter big"><i style="width:${p}%"></i></div>
    <h2 style="margin:.5em 0 0">${eth(c.raised, 3)} ETH</h2><p class="muted" style="margin:0">levés sur ${eth(c.goal, 2)} ETH (${p.toFixed(1)} %)</p>
    <p class="row"><span>${st === 0 ? "⏳ " + dur(left) : STATUS_FR[st]}</span><span>${c.milestones} tranche(s)</span></p>
    ${contributable ? `<label class="f" for="amt">Montant (ETH)</label><input id="amt" type="number" min="0.001" step="0.001" value="0.1">
      <p class="muted small" id="prev"></p><button id="contrib" class="primary" style="width:100%">Contribuer</button>
      <p class="muted small">Vous recevez des CFD <b>verrouillés</b> (non transférables) jusqu'à la livraison complète. Remboursement et destruction des CFD si la campagne échoue.</p>` : `<div class="alert info">Les contributions sont fermées.</div>`}
    ${me ? `<hr style="border:0;border-top:1px solid var(--line)"><p class="small">Votre contribution : <b>${eth(mine)} ETH</b> · CFD verrouillés : <b>${cfd(myLocked)}</b></p>` : `<p class="muted small">Connectez MetaMask pour participer.</p>`}
    ${canRefund ? `<div class="alert bad small">Campagne non aboutie : votre remboursement est effectué automatiquement (CFD détruits).</div>` : ""}
    ${canWithdraw ? `<div class="alert info small">Tranche ${Number(c.tranchesWithdrawn) + 1} validée : le versement est effectué automatiquement.</div>` : ""}
    ${canClaim ? `<div class="alert info small">Projet livré : vos CFD sont débloqués automatiquement.</div>` : ""}
  </aside></div>`;

  const amt = $("#amt");
  if (amt) { const upd = () => { try { $("#prev").textContent = `≈ ${cfd(ethers.parseEther(amt.value || "0") * 1000n)} CFD (1 ETH = 1000 CFD)`; } catch { $("#prev").textContent = ""; } }; amt.oninput = upd; upd(); }
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  on("#contrib", () => { try { const v = ethers.parseEther($("#amt").value || "0"); tx("Contribution", () => S.w.core.contribute(id, { value: v })); } catch { toast("Montant invalide", "bad"); } });
  on("#propTr", () => proposeDialog(0, id));
  on("#propFz", () => proposeDialog(1, id));
  on("#propFreeze", () => proposeDialog(1, id, risk ? "Gel préventif – alerte IA : " + risk.flags.join("; ").slice(0, 380) : ""));
}
function proposeDialog(kind, id, text = "") {
  const d = $("#dlg"), f = $("#dlgForm");
  f.innerHTML = `<h3>${kind === 0 ? "Proposer la validation d'une tranche" : "Proposer le gel de la campagne"} #${id}</h3>
    <p class="muted small">Seuil requis : ${S.cfg.params.proposalThresholdCFD} CFD détenus au snapshot (bloc précédent).</p>
    <label class="f" for="desc">Justification (500 car. max)</label><textarea id="desc" rows="4" maxlength="500">${esc(text)}</textarea>
    <div class="actions"><button value="ok" class="primary">Soumettre</button><button value="no">Annuler</button></div>`;
  f.onsubmit = (e) => { if (e.submitter?.value === "ok") { const t = $("#desc").value.trim(); if (!t) { e.preventDefault(); return; } setTimeout(() => tx("Création de la proposition", () => S.w.dao.propose(kind, id, t)).then(() => (location.hash = "#/dao")), 0); } };
  d.showModal();
}

// ------------------------------------------------------------------ vue : créer
async function viewCreate() {
  const my = S.seq;
  if (my !== S.seq) return;
  app.innerHTML = `<h1>Lancer un projet</h1>
  <form id="f" class="panel" style="max-width:720px">
    <label class="f" for="title">Titre</label><input id="title" required maxlength="120">
    <label class="f" for="desc">Description</label><textarea id="desc" rows="5" required maxlength="2000"></textarea>
    <label class="f" for="cat">Catégorie</label><select id="cat">${CATS.map((c) => `<option>${c}</option>`).join("")}</select>
    <label class="f" for="img">Image (URL https:// ou ipfs://, optionnel)</label><input id="img" type="url">
    <details class="small"><summary>Avancé : j'ai déjà épinglé mes métadonnées sur IPFS</summary>
      <label class="f" for="cidm">CID existant (Qm… ou bafy…) — remplace le titre/description ci-dessus</label><input id="cidm" class="mono" placeholder="bafy… / Qm…"></details>
    <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      <div><label class="f" for="goal">Objectif (ETH)</label><input id="goal" type="number" step="0.01" min="0.01" required value="5"></div>
      <div><label class="f" for="days">Durée (jours, 1–90)</label><input id="days" type="number" min="1" max="90" required value="14"></div>
      <div><label class="f" for="ms">Tranches (1–5)</label><input id="ms" type="number" min="1" max="5" required value="2"></div>
    </div>
    <label class="f" for="ben">Adresse bénéficiaire</label><input id="ben" class="mono" placeholder="0x… (par défaut : votre adresse)" value="${esc(S.account || "")}">
    <div class="alert info small">Les fonds ne sont jamais envoyés d'un coup : le bénéficiaire retire chaque tranche seulement après validation par un vote de la DAO. Frais de plateforme : 2 % par tranche (trésorerie multisig).</div>
    <button class="primary" type="submit">Publier la campagne</button>
  </form>`;
  $("#cidm").oninput = () => { const m = !!$("#cidm").value.trim(); $("#title").required = !m; $("#desc").required = !m; };
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const ben = $("#ben").value.trim() || S.account;
      if (!ethers.isAddress(ben)) return toast("Adresse bénéficiaire invalide", "bad");
      toast("Enregistrement des métadonnées…");
      const manual = $("#cidm").value.trim();
      if (manual && !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/.test(manual)) return toast("CID IPFS invalide", "bad");
      const cid = manual || await uploadMeta({ title: $("#title").value.trim(), description: $("#desc").value.trim(), category: $("#cat").value, image: $("#img").value.trim() });
      if (cid.startsWith("local:")) toast("Pas de jeton Pinata : métadonnées stockées localement (démo).", "");
      const ok = await tx("Création de la campagne", () => S.w.core.createCampaign(ethers.parseEther($("#goal").value), BigInt($("#days").value) * 86400n, ben, cid, Number($("#ms").value)));
      if (ok) location.hash = "#/mine";
    } catch (err) { toast(decodeErr(err), "bad"); }
  };
}


// ------------------------------------------------------------------ vue : mes projets (espace porteur de projet)
async function viewMine() {
  const my = S.seq;
  if (!S.account) {
    if (my !== S.seq) return;
    app.innerHTML = `<h1>Mes projets</h1><div class="alert info">Connectez MetaMask pour voir les projets que vous avez lancés ou dont vous êtes le bénéficiaire.</div>`;
    return;
  }
  const me = S.account.toLowerCase();
  const all = await loadCampaigns();
  const mine = all.filter((x) => x.c.creator.toLowerCase() === me || x.c.beneficiary.toLowerCase() === me).reverse();
  const totalRaised = mine.reduce((s, x) => s + x.c.raised, 0n);
  const ready = mine.filter((x) => x.c.beneficiary.toLowerCase() === me && x.st === 1 && x.c.tranchesWithdrawn < x.c.tranchesApproved).length;

  const hint = (x) => {
    const c = x.c, left = Number(c.deadline) - S.now;
    if (x.st === 0 && c.raised === 0n) return ["Aucune contribution pour l'instant. Partagez votre campagne.", ""];
    if (x.st === 0 && c.raised >= c.goal) return ["Objectif atteint ! Un contributeur peut proposer la validation d'une tranche à la DAO (déblocage anticipé).", "ok"];
    if (x.st === 0) return [`En collecte : encore ${dur(left)}. Il manque ${eth(c.goal - c.raised, 3)} ETH.`, ""];
    if (x.st === 1) {
      if (c.tranchesWithdrawn === c.milestones) return ["Terminée : toutes les tranches sont versées.", "ok"];
      if (c.tranchesWithdrawn < c.tranchesApproved) return [`Tranche ${Number(c.tranchesWithdrawn) + 1} validée par la DAO : versement automatique en cours.`, "ok"];
      return [`En attente d'un vote de la DAO pour la tranche ${Number(c.tranchesApproved) + 1}.`, "warn"];
    }
    if (x.st === 2) return ["Objectif non atteint : les contributeurs sont remboursés automatiquement.", "bad"];
    return ["Campagne annulée ou gelée : les contributeurs sont remboursés automatiquement.", "bad"];
  };

  const card = (x) => {
    const c = x.c, p = pct(c.raised, c.goal);
    const isBen = c.beneficiary.toLowerCase() === me, isCre = c.creator.toLowerCase() === me;
    const [msg, kind] = hint(x);
    const canWithdraw = isBen && x.st === 1 && c.tranchesWithdrawn < c.tranchesApproved;
    const canCancel = isCre && x.st === 0 && c.raised === 0n;
    return `<div class="panel card2">
      <div class="row"><h3><a href="#/campaign/${x.id}">${esc(x.meta.title)}</a></h3>
        <span>${isCre ? '<span class="pill">Créateur</span> ' : ""}${isBen ? '<span class="pill warn">Bénéficiaire</span> ' : ""}${statusPill(x.st)}</span></div>
      <section><p class="sec">Collecte</p><div class="meter"><i style="width:${p}%"></i></div>
        <div class="tiles" style="margin-top:8px">${tile("Levé", eth(c.raised, 3) + " ETH")}${tile("Objectif", eth(c.goal, 2) + " ETH")}${tile("Avancement", p.toFixed(0) + " %")}</div></section>
      <section><p class="sec">Tranches (déblocage des fonds)</p><ul class="trl">${trancheRows(c)}</ul></section>
      <div class="alert ${kind || "info"}" style="margin:0"><b>Prochaine étape :</b> ${esc(msg)}</div>
      ${riskBadge(x.id)}
      <div class="actions" style="margin:0">
        <a class="btn" href="#/campaign/${x.id}">Voir la campagne</a>
        ${canCancel ? `<button data-c="${x.id}">Annuler (aucune contribution)</button>` : ""}
      </div></div>`;
  };

  if (my !== S.seq) return;
  app.innerHTML = `
  <div class="row" style="margin:14px 0"><h1 style="margin:0">Mes projets</h1><a class="btn primary" href="#/create">+ Nouveau projet</a></div>
  <div class="stats" style="margin-bottom:14px">
    <div class="panel"><b>${mine.length}</b><div class="muted small">projet(s)</div></div>
    <div class="panel"><b>${eth(totalRaised, 3)} ETH</b><div class="muted small">levés au total</div></div>
    <div class="panel"><b>${ready}</b><div class="muted small">tranche(s) en cours de versement automatique</div></div>
  </div>
  ${mine.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(400px,1fr))">${mine.map(card).join("")}</div>`
    : `<div class="panel">Vous n'avez encore lancé aucun projet avec ce compte (<span class="mono">${esc(short(S.account))}</span>). <a href="#/create">Lancer mon premier projet →</a></div>`}`;
  app.querySelectorAll("[data-c]").forEach((b) => b.onclick = () => tx("Annulation", () => S.w.core.cancelEmptyCampaign(Number(b.dataset.c))));
}


// ------------------------------------------------------------------ vue : mes contributions (espace contributeur)
async function viewContribs() {
  const my = S.seq;
  if (!S.account) {
    if (my !== S.seq) return;
    app.innerHTML = `<h1>Mes contributions</h1><div class="alert info">Connectez MetaMask pour suivre les projets que vous financez.</div>`;
    return;
  }
  const [all, nProps] = await Promise.all([loadCampaigns(), S.c.dao.proposalCount()]);
  // propositions où j'ai un vote à exprimer (vote ouvert, pouvoir de vote au snapshot, pas encore voté)
  const pending = {};
  for (let i = 0; i < Number(nProps); i++) {
    const [st, voted, w] = await Promise.all([S.c.dao.state(i).then(Number), S.c.dao.hasVoted(i, S.account), S.c.dao.votingWeight(i, S.account)]);
    if (st === 1 && !voted && w[0] > 0n) { const pr = await S.c.dao.getProposal(i); const k = Number(pr.campaignId); (pending[k] = pending[k] || []).push(i); }
  }
  const rows = [];
  for (const x of all) {
    const [mine, tk] = await Promise.all([S.c.core.contributionOf(x.id, S.account), S.c.core.lockedTokensOf(x.id, S.account)]);
    if (mine > 0n) rows.push({ ...x, mine, tk });
  }
  rows.reverse();
  const totalMine = rows.reduce((s, r) => s + r.mine, 0n);
  const nVotes = Object.values(pending).reduce((s, a) => s + a.length, 0);

  const hint = (r) => {
    const c = r.c, left = Number(c.deadline) - S.now;
    if (pending[r.id]) return [`Vous avez ${pending[r.id].length} vote(s) en attente sur ce projet.`, "warn"];
    if (r.st === 0 && c.raised >= c.goal) return ["Objectif atteint. En attente de la validation des tranches par la DAO.", "ok"];
    if (r.st === 0) return [`En collecte : encore ${dur(left)}. Il manque ${eth(c.goal - c.raised, 3)} ETH.`, ""];
    if (r.st === 1) {
      if (c.tranchesWithdrawn === c.milestones) return [r.tk > 0n ? "Projet livré : vos CFD sont débloqués automatiquement." : "Projet livré. Vos CFD sont déjà débloqués.", "ok"];
      return [`${c.tranchesWithdrawn}/${c.milestones} tranche(s) versée(s), ${c.tranchesApproved} validée(s) par la DAO.`, ""];
    }
    if (r.st === 2) return ["Objectif non atteint : vous êtes remboursé automatiquement.", "bad"];
    return ["Campagne gelée ou annulée : vous êtes remboursé automatiquement.", "bad"];
  };

  const card = (r) => {
    const c = r.c, p = pct(c.raised, c.goal);
    const share = c.raised > 0n ? Number((r.mine * 10000n) / c.raised) / 100 : 0;
    const [msg, kind] = hint(r);
    const canRefund = (r.st === 2 || r.st === 3);
    const canClaim = r.st === 1 && c.tranchesWithdrawn === c.milestones && r.tk > 0n;
        return `<div class="panel card2">
      <div class="row"><h3><a href="#/campaign/${r.id}">${esc(r.meta.title)}</a></h3>${statusPill(r.st)}</div>
      <section><p class="sec">Avancement du projet</p>
        <div class="meter"><i style="width:${p}%"></i></div>
        <div class="row" style="margin-top:6px"><span><b>${eth(c.raised, 3)} ETH</b> levés</span><span class="muted">objectif ${eth(c.goal, 2)} ETH · ${p.toFixed(0)} %</span></div></section>
      <section><p class="sec">Ma participation</p>
        <div class="tiles">${tile("Ma contribution", eth(r.mine) + " ETH")}${tile("Ma part du projet", share.toFixed(1) + " %")}${tile("Mes CFD", cfd(r.tk), r.tk > 0n ? "verrouillés" : "transférables")}</div></section>
      <section><p class="sec">Tranches (déblocage des fonds)</p><ul class="trl">${trancheRows(c)}</ul></section>
      <div class="alert ${kind || "info"}" style="margin:0"><b>Prochaine étape :</b> ${esc(msg)}</div>
      ${riskBadge(r.id)}
      <div class="actions" style="margin:0">
        <a class="btn" href="#/campaign/${r.id}">Voir le projet</a>
        ${pending[r.id] ? `<a class="btn primary" href="#/dao">Voter</a>` : ""}
      </div></div>`;
  };

  if (my !== S.seq) return;
  app.innerHTML = `
  <h1>Mes contributions</h1>
  <div class="stats" style="margin-bottom:14px">
    <div class="panel"><b>${rows.length}</b><div class="muted small">projet(s) financé(s)</div></div>
    <div class="panel"><b>${eth(totalMine, 3)} ETH</b><div class="muted small">contribués au total</div></div>
    <div class="panel"><b>${nVotes}</b><div class="muted small">vote(s) en attente</div></div>
  </div>
  ${rows.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(400px,1fr))">${rows.map(card).join("")}</div>`
    : `<div class="panel">Vous n'avez encore financé aucun projet avec ce compte (<span class="mono">${esc(short(S.account))}</span>). <a href="#/">Découvrir les campagnes →</a></div>`}`;
}

// ------------------------------------------------------------------ vue : DAO
async function viewDao() {
  const my = S.seq;
  const [n, treasuryBal, fees, paused] = await Promise.all([S.c.dao.proposalCount(), S.read.getBalance(S.cfg.addresses.treasury), S.c.core.accruedFees(), S.c.core.paused()]);
  const items = [];
  for (let i = Number(n) - 1; i >= 0; i--) {
    const [p, s] = await Promise.all([S.c.dao.getProposal(i), S.c.dao.state(i).then(Number)]);
    const w = S.account ? await S.c.dao.votingWeight(i, S.account) : [0n, 0n];
    const voted = S.account ? await S.c.dao.hasVoted(i, S.account) : false;
    const meta = await loadMeta((await S.c.core.getCampaign(p.campaignId)).metadataCid);
    items.push({ i, p, s, w, voted, meta });
  }
  const P = S.cfg.params;
  if (my !== S.seq) return;
  app.innerHTML = `<h1>Gouvernance DAO</h1>
  <div class="stats" style="margin-bottom:14px">
    <div class="panel"><b>${P.proposalThresholdCFD} CFD</b><div class="muted small">pour proposer</div></div>
    <div class="panel"><b>${dur(P.votingPeriod)}</b><div class="muted small">période de vote</div></div>
    <div class="panel"><b>${dur(P.timelockDelay)}</b><div class="muted small">timelock avant exécution</div></div>
    <div class="panel"><b>${P.quorumVoters} votants</b><div class="muted small">quorum minimal</div></div>
    <div class="panel"><b>${eth(treasuryBal, 3)} ETH</b><div class="muted small">trésorerie multisig (+ ${eth(fees, 3)} à transférer)</div></div>
  </div>
  ${paused ? `<div class="alert bad">⏸ Plateforme en pause (circuit breaker).</div>` : ""}
  <div class="alert info small"><b>Comment votez-vous ?</b> Poids = √(CFD détenus au <i>snapshot</i>) — vote quadratique : 4× plus de jetons = 2× plus de voix. Les jetons acquis après la création de la proposition ne comptent pas (anti flash-loan).
  ${S.fraud && Object.keys(S.fraud).length ? "" : ""}</div>
  ${items.length ? items.map(propHtml).join("") : `<div class="panel">Aucune proposition. Ouvrez une campagne pour en créer une.</div>`}
  ${S.cfg.addresses.treasury ? `<p class="muted small">Contrats : DAO <span class="mono">${esc(S.cfg.addresses.dao)}</span> · Core <span class="mono">${esc(S.cfg.addresses.core)}</span> · CFD <span class="mono">${esc(S.cfg.addresses.token)}</span></p>` : ""}
  <div class="actions"><a class="btn ghost" href="#/treasury" style="padding:9px 14px">Ouvrir la trésorerie multisig →</a></div>`;
  app.querySelectorAll("[data-act]").forEach((b) => b.onclick = () => {
    const [a, i] = [b.dataset.act, Number(b.dataset.i)];
    if (a === "yes" || a === "no") tx("Vote", () => S.w.dao.castVote(i, a === "yes"));
  });
}
function propHtml({ i, p, s, w, voted, meta }) {
  const f = Number(p.forVotes), a = Number(p.againstVotes), tot = f + a || 1;
  const end = Number(p.voteEnd), eta = Number(p.eta);
  const act = [];
  if (s === 1 && !voted && w[0] > 0n) act.push(`<button data-act="yes" data-i="${i}" class="primary">Pour (poids ${w[0]})</button><button data-act="no" data-i="${i}">Contre</button>`);
  if (s === 1 && voted) act.push(`<span class="pill ok">Vous avez voté</span>`);
  if (s === 1 && !voted && w[0] === 0n && S.account) act.push(`<span class="muted small">Pas de pouvoir de vote au snapshot.</span>`);
  if (s === 3) act.push(`<span class="pill warn">Adoptée : mise en file en cours…</span>`);
  if (s === 4) act.push(eta <= S.now ? `<span class="pill warn">Timelock écoulé : exécution en cours…</span>` : `<span class="pill warn">Timelock : ${dur(eta - S.now)}</span>`);
  return `<div class="panel prop">
    <div class="row"><b>#${i} · ${p.kind === 0n ? "✔ Valider une tranche" : "❄ Geler la campagne"} — <a href="#/campaign/${p.campaignId}">${esc(meta.title)}</a></b><span class="pill ${s === 5 ? "ok" : s === 2 || s === 6 ? "bad" : ""}">${PSTATE_FR[s]}</span></div>
    <p class="muted">${esc(p.description)}</p>
    <div class="vote" aria-label="Pour ${f}, contre ${a}"><div class="y" style="width:${(f / tot) * 100}%"></div><div class="n" style="width:${(a / tot) * 100}%"></div></div>
    <div class="row muted small"><span>Pour ${f} · Contre ${a}</span><span>${p.voters} votant(s) / quorum ${S.cfg.params.quorumVoters}</span><span>${s === 1 ? "fin du vote dans " + dur(end - S.now) : "snapshot bloc " + p.snapshotBlock}</span></div>
    <div class="actions">${act.join("")}</div></div>`;
}


// ------------------------------------------------------------------ vue : trésorerie multisig
async function viewTreasury() {
  const my = S.seq, T = S.c.treasury, A = S.cfg.addresses.treasury;
  const [owners, req, limit, n, bal, fees] = await Promise.all([T.getOwners(), T.required(), T.smallLimit(), T.txCount(), S.read.getBalance(A), S.c.core.accruedFees()]);
  const isOwner = S.account ? await T.isOwner(S.account) : false;
  const rows = [];
  for (let i = Number(n) - 1; i >= 0; i--) {
    const [t, need] = await Promise.all([T.getTx(i), T.neededConfirmations(i)]);
    const mine = S.account ? await T.confirmed(i, S.account) : false;
    rows.push({ i, t, need: Number(need), mine });
  }
  if (my !== S.seq) return;
  app.innerHTML = `<p><a href="#/dao">← Gouvernance</a></p><h1>Trésorerie multisig</h1>
  <div class="stats" style="margin-bottom:14px">
    <div class="panel"><b>${eth(bal, 4)} ETH</b><div class="muted small">solde (+ ${eth(fees, 3)} frais à transférer)</div></div>
    <div class="panel"><b>${req} sur ${owners.length}</b><div class="muted small">signatures requises</div></div>
    <div class="panel"><b>${ethers.formatEther(limit)} ETH</b><div class="muted small">seuil : en dessous, 1 signature suffit (envoi simple)</div></div>
  </div>
  <div class="panel"><b>Propriétaires</b>${owners.map((o) => `<div class="mono small">${esc(o)}${S.account && o.toLowerCase() === S.account.toLowerCase() ? " <span class='pill ok'>vous</span>" : ""}</div>`).join("")}</div>
  <div class="alert info small">Règle : un envoi simple de <b>${ethers.formatEther(limit)} ETH ou moins</b> exige 1 confirmation ; au-delà, ou pour tout appel de contrat, il en faut <b>${req}</b>.</div>
  ${isOwner ? `<form id="tf" class="panel"><b>Proposer un paiement</b>
    <div class="row"><input id="tto" placeholder="Adresse destinataire 0x…" required style="flex:2"><input id="tval" type="number" step="any" min="0" placeholder="Montant ETH" required style="flex:1"><button class="primary">Soumettre</button></div></form>`
    : `<div class="alert small">Connectez un compte propriétaire pour soumettre / confirmer des transactions.</div>`}
  <h2>Transactions</h2>
  ${rows.length ? rows.map(({ i, t, need, mine }) => {
    const act = [];
    if (!t.executed && isOwner) {
      if (!mine) act.push(`<button data-a="c" data-i="${i}">Confirmer</button>`); else act.push(`<button data-a="r" data-i="${i}" class="ghost">Retirer ma confirmation</button>`);
      if (Number(t.confirmations) >= need) act.push(`<button data-a="x" data-i="${i}" class="primary">Exécuter</button>`);
    }
    return `<div class="panel"><div class="row"><b>#${i} · ${eth(t.value, 4)} ETH → <span class="mono">${short(t.to)}</span></b>
      <span class="pill ${t.executed ? "ok" : "warn"}">${t.executed ? "Exécutée" : t.confirmations + " / " + need + " confirmations"}</span></div>
      <div class="actions">${act.join("")}</div></div>`;
  }).join("") : `<div class="panel muted">Aucune transaction.</div>`}`;
  const f = $("#tf");
  if (f) f.onsubmit = (e) => { e.preventDefault(); tx("Soumission du paiement", () => S.w.treasury.submit($("#tto").value.trim(), ethers.parseEther($("#tval").value), "0x")); };
  app.querySelectorAll("[data-a]").forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.i), a = b.dataset.a;
    tx(a === "c" ? "Confirmation" : a === "r" ? "Retrait de confirmation" : "Exécution", () => S.w.treasury[a === "c" ? "confirm" : a === "r" ? "revoke" : "execute"](i));
  });
}

// ------------------------------------------------------------------ vue : compte
async function viewAccount() {
  const my = S.seq;
  if (!S.account) { app.innerHTML = `<h1>Mon compte</h1><div class="alert info">Connectez MetaMask pour voir vos jetons et vos contributions.</div>`; return; }
  const [bal, locked, votes, ethBal, n] = await Promise.all([S.c.token.balanceOf(S.account), S.c.token.lockedBalanceOf(S.account), S.c.token.getVotes(S.account), S.read.getBalance(S.account), S.c.core.campaignCount()]);
  const rows = [];
  for (let id = 0; id < Number(n); id++) {
    const [mine, tk] = await Promise.all([S.c.core.contributionOf(id, S.account), S.c.core.lockedTokensOf(id, S.account)]);
    if (mine > 0n) { const c = await S.c.core.getCampaign(id); const st = Number(await S.c.core.effectiveStatus(id)); rows.push({ id, mine, tk, st, meta: await loadMeta(c.metadataCid) }); }
  }
  if (my !== S.seq) return;
  app.innerHTML = `<h1>Mon compte</h1><p class="mono muted">${esc(S.account)}</p>
  <div class="stats" style="margin-bottom:14px">
    <div class="panel"><b>${eth(ethBal, 4)} ETH</b><div class="muted small">solde</div></div>
    <div class="panel"><b>${cfd(bal)} CFD</b><div class="muted small">total</div></div>
    <div class="panel"><b>${cfd(locked)} CFD</b><div class="muted small">verrouillés (non transférables)</div></div>
    <div class="panel"><b>${cfd(bal - locked)} CFD</b><div class="muted small">transférables</div></div>
    <div class="panel"><b>${cfd(votes)}</b><div class="muted small">votes délégués (auto-délégation)</div></div>
  </div>
  <h2>Mes contributions</h2>
  ${rows.length ? `<div class="panel"><table><thead><tr><th>Campagne</th><th>Statut</th><th>Montant</th><th>CFD verrouillés</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><a href="#/campaign/${r.id}">${esc(r.meta.title)}</a></td><td>${statusPill(r.st)}</td><td>${eth(r.mine)} ETH</td><td>${cfd(r.tk)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Aucune contribution pour l'instant.</p>`}`;
}

init();