// FUZZING par propriétés (fast-check) : des séquences d'actions ALEATOIRES sont jouées sur les contrats
// et des INVARIANTS doivent rester vrais après CHAQUE action. En cas d'échec, fast-check « réduit »
// automatiquement la séquence au plus petit contre-exemple (shrinking) et affiche la graine pour le rejouer.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fc = require("fast-check");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll, createCampaign, time, DAY } = require("./helpers");

describe("Fuzzing par propriétés (fast-check)", function () {
  this.timeout(900000);

  it("invariants : solvabilité du Core et cohérence des CFD, sous des séquences aléatoires", async () => {
    const { core, token, creator, beneficiary, alice, bob, carol, dave } = await deployAll();
    const users = [alice, bob, carol, dave];
    // 2 campagnes dont l'objectif est inatteignable : elles échouent à l'échéance -> remboursables
    for (let i = 0; i < 2; i++) await createCampaign(core, creator, beneficiary, { goal: "100000", duration: 7 * DAY, milestones: 2 });
    const snap = await takeSnapshot();
    const coreAddr = await core.getAddress();
    const TOKENS_PER_ETH = 1000n;

    const op = fc.oneof(
      fc.record({ t: fc.constant("contribute"), u: fc.nat(3), c: fc.nat(1), milli: fc.integer({ min: 1, max: 3000 }) }),
      fc.record({ t: fc.constant("refund"), u: fc.nat(3), c: fc.nat(1) }),
      fc.record({ t: fc.constant("wait") })
    );

    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        await snap.restore();
        runs++;
        let refunded = 0n; // modèle : total remboursé

        for (const o of ops) {
          if (o.t === "contribute") {
            const v = ethers.parseEther("0.001") * BigInt(o.milli);
            await core.connect(users[o.u]).contribute(o.c, { value: v }).catch(() => {}); // peut échouer après l'échéance
          } else if (o.t === "refund") {
            const before = await core.contributionOf(o.c, users[o.u].address);
            const ok = await core.connect(users[o.u]).refund(o.c).then(() => true, () => false);
            if (ok) refunded += before; // sans retrait de tranche, remboursement = contribution exacte
          } else {
            await time.increase(8 * DAY);
          }

          // ---- INVARIANTS (doivent toujours tenir) ----
          let raised = 0n;
          for (let c = 0; c < 2; c++) raised += (await core.getCampaign(c)).raised;
          const balance = await ethers.provider.getBalance(coreAddr);
          // I1 solvabilité : le Core détient EXACTEMENT les fonds levés moins les remboursements
          expect(balance).to.equal(raised - refunded);
          // I2 les CFD en circulation == 1000 x l'ETH encore engagé (aucun jeton « gratuit » ni orphelin)
          expect(await token.totalSupply()).to.equal(balance * TOKENS_PER_ETH);
          // I3 les CFD verrouillés d'un utilisateur == 1000 x ses contributions
          for (const u of users) {
            let mine = 0n;
            for (let c = 0; c < 2; c++) mine += await core.contributionOf(c, u.address);
            expect(await token.lockedBalanceOf(u.address)).to.equal(mine * TOKENS_PER_ETH);
          }
        }
        return true;
      }),
      { numRuns: Number(process.env.FUZZ_RUNS || 100), endOnFailure: false }
    );
    console.log(`      ${runs} séquences aléatoires jouées (avec réduction automatique en cas d'échec)`);
  });
  it("invariant de gouvernance : somme des poids de vote <= offre de CFD au snapshot (et = soldes des votants)", async () => {
    const { core, dao, token, creator, beneficiary, alice, bob, carol, dave } = await deployAll();
    const users = [alice, bob, carol, dave];
    await createCampaign(core, creator, beneficiary, { goal: "100000", duration: 30 * DAY, milestones: 2 });
    const snap = await takeSnapshot();
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 4, maxLength: 4 }), // contributions en milli-ETH (0 = aucune)
        fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),                       // vote pour / contre
        async (milli, sides) => {
          await snap.restore(); runs++;
          milli[0] = Math.max(milli[0], 20); // alice détient au moins 20 CFD : elle peut proposer (seuil 10 CFD)
          for (let i = 0; i < 4; i++) if (milli[i] >= 1) await core.connect(users[i]).contribute(0, { value: ethers.parseEther("0.001") * BigInt(milli[i]) });
          await dao.connect(alice).propose(0, 0, "fuzz");
          let expected = 0n;
          for (let i = 0; i < 4; i++) {
            const ok = await dao.connect(users[i]).castVote(0, sides[i]).then(() => true, () => false);
            if (ok) expected += ethers.parseEther("0.001") * BigInt(milli[i]) * 1000n;
          }
          const p = await dao.getProposal(0);
          const supply = await token.getPastTotalSupply(p.snapshotBlock);
          const total = p.forVotes + p.againstVotes;
          expect(total).to.be.lte(supply);   // jamais plus de voix que de jetons
          expect(total).to.equal(expected);  // exactement la somme des soldes des votants (aucun arrondi)
          return true;
        }
      ),
      { numRuns: Number(process.env.FUZZ_RUNS || 100), endOnFailure: false }
    );
    console.log(`      ${runs} scénarios de vote aléatoires`);
  });
});