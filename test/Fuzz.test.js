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
      { numRuns: 40, endOnFailure: false }
    );
    console.log(`      ${runs} séquences aléatoires jouées (avec réduction automatique en cas d'échec)`);
  });
});
