/* Cloche de notifications : lit les ÉVÉNEMENTS de la chaîne (aucun serveur, aucune base de données).
   Chaque nouveauté (campagne, proposition, vote adopté, tranche, remboursement…) apparaît dans la cloche
   à côté du compte. « Pour vous » = événement qui concerne l'adresse connectée. Non lu = bloc plus récent
   que la dernière ouverture de la cloche (mémorisé dans ce navigateur, par compte). */
"use strict";
(() => {
  const N = { items: [], seen: new Map(), camps: new Map(), from: null, last: null, ts: new Map(), first: true, open: false, key: "" };
  const STAT_FR = { 1: "réussie 🎉", 2: "échouée (remboursement automatique)", 3: "annulée / gelée" };
  const me = () => (S.account || "").toLowerCase();
  const isMe = (a) => !!me() && String(a).toLowerCase() === me();
  const storeKey = () => "notif:seen:" + S.cfg.addresses.core.slice(2, 10) + ":" + (me() || "invite");
  const getSeen = () => { try { return Number(localStorage.getItem(storeKey())); } catch { return NaN; } };
  const setSeen = (b) => { try { localStorage.setItem(storeKey(), String(b)); } catch { /* ignore */ } };

  function mount() {
    if ($("#bell")) return;
    const b = document.createElement("button");
    b.id = "bell"; b.className = "ghost bell"; b.title = "Notifications"; b.setAttribute("aria-label", "Notifications");
    b.innerHTML = `🔔<span id="bellN" class="badge hidden">0</span>`;
    const pop = document.createElement("div");
    pop.id = "notifPop"; pop.className = "notif hidden"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Notifications");
    $(".right").prepend(b); $(".right").append(pop);
    b.onclick = (e) => { e.stopPropagation(); N.open ? close() : openPop(); };
    document.addEventListener("click", (e) => { if (N.open && !pop.contains(e.target)) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    pop.onclick = (e) => {
      if (e.target.closest("[data-readall]")) { markRead(); render(); }
      if (e.target.closest("a")) close();
    };
  }
  const unread = () => N.items.filter((n) => n.block > N.seen.get(N.key)).length;
  function markRead() { if (N.last != null) { N.seen.set(N.key, N.last); setSeen(N.last); } updateBadge(); }
  function close() { N.open = false; $("#notifPop").classList.add("hidden"); }
  function openPop() { N.open = true; render(); $("#notifPop").classList.remove("hidden"); }

  function updateBadge() {
    const n = unread(), el = $("#bellN");
    if (!el) return;
    el.textContent = n > 99 ? "99+" : n; el.classList.toggle("hidden", n === 0);
    $("#bell").classList.toggle("ring", n > 0);
    document.title = (n ? `(${n}) ` : "") + document.title.replace(/^\(\d+\)\s*/, "");
  }
  async function stamp(block) {
    if (N.ts.has(block)) return N.ts.get(block);
    try { N.ts.set(block, (await S.read.getBlock(block)).timestamp); } catch { N.ts.set(block, null); }
    return N.ts.get(block);
  }
  const ago = (t) => { if (!t) return ""; const s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 60 ? "à l'instant" : "il y a " + dur(s); };

  async function render() {
    const pop = $("#notifPop"), list = N.items.slice(-40).reverse();
    await Promise.all(list.slice(0, 15).filter((n) => !n.sub).map((n) => stamp(n.block)));
    const seen = N.seen.get(N.key);
    pop.innerHTML = `<div class="nhead"><b>Notifications</b><button class="ghost small" data-readall>Tout marquer comme lu</button></div>` +
      (list.length ? list.map((n) => `<a class="nitem ${n.block > seen ? "new" : ""} ${n.mine ? "mine" : ""}" href="${n.href}">
          <span class="nic">${n.icon}</span><span class="ntx">${n.mine ? `<em>Pour vous</em> ` : ""}${n.text}<small>${n.sub || ago(N.ts.get(n.block)) + " · bloc " + n.block}</small></span></a>`).join("")
        : `<p class="muted small" style="padding:14px">Rien pour l'instant. Les nouveautés de la plateforme s'afficheront ici.</p>`);
  }

  async function decode(log, blockTs) {
    const core = S.c.core, dao = S.c.dao;
    const isCore = log.address.toLowerCase() === S.cfg.addresses.core.toLowerCase();
    let ev; try { ev = (isCore ? core : dao).interface.parseLog(log); } catch { return null; }
    if (!ev) return null;
    const a = ev.args, base = { block: log.blockNumber, idx: log.index, href: "#/", mine: false };
    const camp = async (id) => {
      const c = N.camps.get(String(id)); if (!c) return `la campagne #${id}`;
      const m = await loadMeta(c.cid); return `« ${esc(m.title)} »`;
    };
    const cl = (id) => `#/campaign/${id}`;
    switch (ev.name) {
      case "CampaignCreated": {
        N.camps.set(String(a.id), { creator: a.creator, beneficiary: a.beneficiary, cid: a.metadataCid });
        const mine = isMe(a.creator);
        return { ...base, icon: "🚀", mine, href: cl(a.id), text: mine ? `Votre campagne ${await camp(a.id)} est en ligne.` : `Nouvelle campagne : ${await camp(a.id)} (objectif ${eth(a.goal, 2)} ETH).` };
      }
      case "Contributed": {
        const c = N.camps.get(String(a.id)), mine = isMe(a.contributor) || (c && isMe(c.creator));
        const who = isMe(a.contributor) ? "Vous avez contribué" : `${short(a.contributor)} a contribué`;
        return { ...base, icon: "💚", mine, href: cl(a.id), text: `${who} ${eth(a.amount, 3)} ETH à ${await camp(a.id)}.` };
      }
      case "ProposalCreated":
        return { ...base, icon: "🗳", href: "#/dao", mine: false, text: `Nouveau vote #${a.id} ${a.kind === 0n ? "(valider une tranche)" : "(geler la campagne)"} sur ${await camp(a.campaignId)} : ${esc(a.description)}. <b>Votez avant la fin !</b>` };
      case "ProposalQueued": return { ...base, icon: "⏳", href: "#/dao", text: `Proposition #${a.id} adoptée : elle entre en période de sécurité (timelock).` };
      case "ProposalExecuted": return { ...base, icon: "✅", href: "#/dao", text: `Proposition #${a.id} exécutée.` };
      case "ProposalCanceled": return { ...base, icon: "🛑", href: "#/dao", text: `Proposition #${a.id} annulée par le veto du multisig : ${esc(a.reason)}` };
      case "TrancheApproved": return { ...base, icon: "🔓", href: cl(a.id), text: `Tranche ${Number(a.trancheIndex) + 1} validée pour ${await camp(a.id)}.` };
      case "FundsWithdrawn": {
        const mine = isMe(a.beneficiary);
        return { ...base, icon: "💸", mine, href: cl(a.id), text: `${mine ? "Vous avez reçu" : "Versement de"} ${eth(a.net, 3)} ETH (tranche ${Number(a.trancheIndex) + 1}) — ${await camp(a.id)}.` };
      }
      case "Refunded": {
        const mine = isMe(a.contributor);
        return { ...base, icon: "↩️", mine, href: "#/contribs", text: `${mine ? "Vous avez été remboursé de" : `${short(a.contributor)} remboursé de`} ${eth(a.amount, 3)} ETH — ${await camp(a.id)}.` };
      }
      case "TokensClaimed": {
        const mine = isMe(a.contributor);
        return { ...base, icon: "🔑", mine, href: "#/account", text: `${mine ? "Vos" : "Des"} ${cfd(a.amount)} CFD sont déverrouillés (${await camp(a.id)} livrée).` };
      }
      case "CampaignFrozen": return { ...base, icon: "❄", href: cl(a.id), text: `${await camp(a.id)} a été gelée par la DAO : remboursement au prorata.` };
      case "StatusChanged": {
        const s = Number(a.status); if (!STAT_FR[s]) return null;
        return { ...base, icon: s === 1 ? "🎉" : "ℹ️", href: cl(a.id), text: `${await camp(a.id)} : campagne ${STAT_FR[s]}.` };
      }
      default: return null;
    }
  }

  async function logs(from, to) {
    const out = [], STEP = 9000;
    for (let s = from; s <= to; s += STEP) {
      const e = Math.min(to, s + STEP - 1);
      out.push(...await S.read.getLogs({ address: [S.cfg.addresses.core, S.cfg.addresses.dao], fromBlock: s, toBlock: e }));
    }
    return out;
  }

  async function poll() {
    if (!S.cfg || !S.read || S.c.core == null) return;
    mount();
    try {
      const head = await S.read.getBlockNumber();
      const key = (me() || "invite");
      if (N.key !== key) { N.key = key; N.first = true; N.items = []; N.from = null; N.camps.clear(); }
      if (N.from == null) N.from = Math.max(0, S.cfg.deployedAtBlock ?? 0);
      if (head < N.from) { if (head < N.from - 1) { N.from = Math.max(0, S.cfg.deployedAtBlock ?? 0); N.items = []; N.camps.clear(); } return; }
      const fresh = (await logs(N.from, head)).sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
      N.from = head + 1;
      const made = [];
      for (const l of fresh) { const n = await decode(l); if (n) made.push(n); }
      N.items.push(...made); N.last = head;
      if (N.first) {
        // 1re ouverture de ce compte : l'historique n'est pas « non lu », seules les nouveautés à venir le seront.
        const stored = getSeen();
        N.seen.set(N.key, Number.isFinite(stored) && stored > 0 ? stored : head);
        if (!(Number.isFinite(stored) && stored > 0)) setSeen(head);
        N.first = false;
      } else {
        for (const n of made) if (n.block > N.seen.get(N.key)) toast(`🔔 ${n.text.replace(/<[^>]+>/g, "")}`, n.mine ? "ok" : "");
      }
      // Alertes IA : une campagne passe en risque ÉLEVÉ (rapport écrit en continu par analysis/fraud_detector.py --watch)
      let known; try { known = JSON.parse(localStorage.getItem("notif:fraud:" + S.cfg.addresses.core.slice(2, 10)) || "{}"); } catch { known = {}; }
      for (const [id, r] of Object.entries(S.fraud || {})) {
        if (r.risk_level !== "ÉLEVÉ" || known[id] === "ÉLEVÉ") continue;
        known[id] = "ÉLEVÉ";
        const m = N.camps.get(String(id)) ? await loadMeta(N.camps.get(String(id)).cid) : { title: "campagne #" + id };
        const it = { block: head + 1, idx: 0, icon: "⚠️", mine: false, href: "#/campaign/" + id, sub: "détecté par l'IA · à l'instant",
          text: `<b>Alerte IA :</b> « ${esc(m.title)} » présente un risque ÉLEVÉ (${esc(r.risk_score)}/100). Proposez un gel à la DAO si nécessaire.` };
        N.items.push(it); toast(`🔔 Alerte IA : « ${m.title} » — risque ÉLEVÉ (${r.risk_score}/100)`, "bad");
      }
      try { localStorage.setItem("notif:fraud:" + S.cfg.addresses.core.slice(2, 10), JSON.stringify(known)); } catch { /* ignore */ }
      if (N.open) markRead(); // la cloche est ouverte : tout ce qui arrive est lu
      updateBadge(); if (N.open) render();
    } catch (e) { console.warn("notifications :", e.message || e); }
  }

  const start = () => { if (typeof S !== "undefined" && S.cfg && S.read && S.c && S.c.core) { poll(); setInterval(poll, 5000); } else setTimeout(start, 500); };
  window.addEventListener("load", start);
})();