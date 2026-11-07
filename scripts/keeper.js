// ROBOT D'AUTOMATISATION (keeper) : fait tout ce qu'une vraie plateforme ferait « toute seule ».
// Une blockchain ne se déclenche jamais seule : ce robot envoie les transactions à la place des utilisateurs.
// Il n'a AUCUN privilège : chaque fonction qu'il appelle est publique et l'argent / les jetons vont
// TOUJOURS à leur propriétaire légitime (contributeur, bénéficiaire, trésorerie), jamais au robot.
//
// Ce qu'il automatise :
//   1. DAO        : proposition adoptée -> mise en file ; timelock écoulé -> exécution ; propositions rejetées/expirées -> libération du verrou
//   2. Versement  : tranche validée par la DAO -> envoyée au bénéficiaire (moins 2 % de frais)
//   3. Jetons CFD : campagne livrée (toutes tranches versées) -> déblocage des CFD de chaque contributeur
//   4. Remboursement : campagne échouée / gelée -> chaque contributeur est remboursé (CFD détruits)
//   5. Frais      : frais accumulés -> transférés vers la trésorerie multisig
//
// Usage :  npm run keeper            (continu, Ctrl+C pour arrêter)
//          ONCE=1 npm run keeper     (un seul passage)     POLL_MS=3000 pour l'intervalle (défaut 5000)
// En production : Chainlink Automation / Gelato remplacent ce script pour la partie DAO (checkUpkeep/performUpkeep).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const log = (m) => console.log(`[keeper] ${m}`);

// Envoie une transaction seulement si une simulation préalable réussit (évite de gaspiller du gas).
async function attempt(label, contract, fn, ...args) {
  try { await contract[fn].staticCall(...args); } catch { return 0; }
  try { const tx = await contract[fn](...args); await tx.wait(); log(label); return 1; }
  catch (e) { log(`${label} : échec (${e.shortMessage || e.message})`); return 0; }
}

async function pass(core, dao) {
  const { ethers } = hre;
  let acted = 0;

  // ---- 1. DAO
  const np = Number(await dao.proposalCount());
  for (let i = 0; i < np; i++) {
    const s = Number(await dao.state(i));
    if (s === 3) acted += await attempt(`proposition #${i} : MISE EN FILE (timelock démarré)`, dao, "queue", i);
    else if (s === 4) acted += await attempt(`proposition #${i} : EXÉCUTÉE`, dao, "execute", i);
    else if (s === 2 || s === 6) {
      const p = await dao.getProposal(i);
      const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint256"], [p.kind, p.campaignId]));
      if (await dao.openProposal(key)) acted += await attempt(`proposition #${i} : verrou anti-spam libéré`, dao, "release", i);
    }
  }

  // ---- 2 à 4. Campagnes
  const nc = Number(await core.campaignCount());
  for (let id = 0; id < nc; id++) {
    const c = await core.getCampaign(id);
    const st = Number(await core.effectiveStatus(id)); // 0 Active, 1 Réussie, 2 Échouée, 3 Annulée/gelée
    const n = Number(await core.contributorCount(id));

    if (st === 1 && c.tranchesWithdrawn < c.tranchesApproved)
      acted += await attempt(`campagne #${id} : tranche ${Number(c.tranchesWithdrawn) + 1} VERSÉE au bénéficiaire`, core, "payout", id);

    if (st === 1 && c.tranchesWithdrawn === c.milestones) {
      for (let k = 0; k < n; k++) {
        const who = await core.contributorAt(id, k);
        if ((await core.lockedTokensOf(id, who)) > 0n) acted += await attempt(`campagne #${id} : CFD DÉBLOQUÉS pour ${who.slice(0, 8)}…`, core, "claimTokensFor", id, who);
      }
    }

    if (st === 2 || st === 3) {
      for (let k = 0; k < n; k++) {
        const who = await core.contributorAt(id, k);
        if ((await core.contributionOf(id, who)) > 0n) acted += await attempt(`campagne #${id} : REMBOURSEMENT de ${who.slice(0, 8)}…`, core, "refundFor", id, who);
      }
    }
  }

  // ---- 5. Frais
  if ((await core.accruedFees()) > 0n) acted += await attempt("FRAIS transférés vers la trésorerie multisig", core, "sweepFees");
  return acted;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "../frontend/contracts.json")));
  const [signer] = await hre.ethers.getSigners();
  const dao = await hre.ethers.getContractAt(cfg.abis.dao, cfg.addresses.dao, signer);
  const core = await hre.ethers.getContractAt(cfg.abis.core, cfg.addresses.core, signer);
  log(`démarré sur ${hre.network.name} | DAO ${cfg.addresses.dao} | compte ${signer.address}`);
  if (process.env.ONCE) { const a = await pass(core, dao); log(`terminé (${a} action(s))`); return; }
  const every = Number(process.env.POLL_MS || 5000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await pass(core, dao); } catch (e) { log("erreur de passage : " + (e.shortMessage || e.message)); }
    await new Promise((r) => setTimeout(r, every));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });