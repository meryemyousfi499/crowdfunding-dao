const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployAll, createCampaign, time, DAY } = require("./helpers");

describe("CFDToken (M1 - Tokenisation)", () => {
  it("frappe automatiquement des CFD verrouillés à la contribution (1 ETH = 1000 CFD)", async () => {
    const { core, token, creator, beneficiary, alice } = await deployAll();
    const id = await createCampaign(core, creator, beneficiary);
    await core.connect(alice).contribute(id, { value: ethers.parseEther("2") });
    expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("2000"));
    expect(await token.lockedBalanceOf(alice.address)).to.equal(ethers.parseEther("2000"));
  });

  it("interdit le transfert des jetons verrouillés", async () => {
    const { core, token, creator, beneficiary, alice, bob } = await deployAll();
    const id = await createCampaign(core, creator, beneficiary);
    await core.connect(alice).contribute(id, { value: ethers.parseEther("1") });
    await expect(token.connect(alice).transfer(bob.address, 1n)).to.be.revertedWithCustomError(
      token,
      "InsufficientUnlockedBalance"
    );
  });

  it("seul le Core peut frapper / verrouiller (contrôle d'accès)", async () => {
    const { token, alice } = await deployAll();
    await expect(token.connect(alice).mintLocked(alice.address, 1n)).to.be.reverted;
    await expect(token.connect(alice).unlock(alice.address, 1n)).to.be.reverted;
  });

  it("auto-délègue les votes au détenteur", async () => {
    const { core, token, creator, beneficiary, alice } = await deployAll();
    const id = await createCampaign(core, creator, beneficiary);
    await core.connect(alice).contribute(id, { value: ethers.parseEther("1") });
    expect(await token.delegates(alice.address)).to.equal(alice.address);
    expect(await token.getVotes(alice.address)).to.equal(ethers.parseEther("1000"));
  });
});

describe("CrowdfundingCore (M2)", () => {
  describe("création et contribution", () => {
    it("crée une campagne et émet l'événement", async () => {
      const { core, creator, beneficiary } = await deployAll();
      await expect(core.connect(creator).createCampaign(ethers.parseEther("5"), 7 * DAY, beneficiary.address, "QmX", 2))
        .to.emit(core, "CampaignCreated");
      const c = await core.getCampaign(0);
      expect(c.goal).to.equal(ethers.parseEther("5"));
      expect(c.status).to.equal(0n); // Active
    });

    it("rejette les paramètres invalides", async () => {
      const { core, creator, beneficiary } = await deployAll();
      const g = ethers.parseEther("1");
      await expect(core.connect(creator).createCampaign(0, 7 * DAY, beneficiary.address, "Qm", 1)).to.be.revertedWithCustomError(core, "InvalidParameters");
      await expect(core.connect(creator).createCampaign(g, 10, beneficiary.address, "Qm", 1)).to.be.revertedWithCustomError(core, "InvalidParameters");
      await expect(core.connect(creator).createCampaign(g, 7 * DAY, ethers.ZeroAddress, "Qm", 1)).to.be.revertedWithCustomError(core, "InvalidParameters");
      await expect(core.connect(creator).createCampaign(g, 7 * DAY, beneficiary.address, "", 1)).to.be.revertedWithCustomError(core, "InvalidParameters");
      await expect(core.connect(creator).createCampaign(g, 7 * DAY, beneficiary.address, "Qm", 9)).to.be.revertedWithCustomError(core, "InvalidParameters");
    });

    it("refuse contribution trop faible, auto-financement et après échéance", async () => {
      const { core, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary);
      await expect(core.connect(alice).contribute(id, { value: 1n })).to.be.revertedWithCustomError(core, "ContributionTooLow");
      await expect(core.connect(creator).contribute(id, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(core, "SelfFunding");
      await expect(core.connect(beneficiary).contribute(id, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(core, "SelfFunding");
      await time.increase(8 * DAY);
      await expect(core.connect(alice).contribute(id, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(core, "CampaignNotActive");
    });
  });

  describe("cycle de vie (Active / Success / Failed / Canceled)", () => {
    it("Failed si objectif non atteint à l'échéance, puis remboursement + burn des CFD", async () => {
      const { core, token, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary);
      await core.connect(alice).contribute(id, { value: ethers.parseEther("3") });
      expect(await core.effectiveStatus(id)).to.equal(0n);
      await time.increase(8 * DAY);
      expect(await core.effectiveStatus(id)).to.equal(2n); // Failed

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await core.connect(alice).refund(id);
      const r = await tx.wait();
      const gas = r.gasUsed * r.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before + gas).to.equal(ethers.parseEther("3"));
      expect(await token.balanceOf(alice.address)).to.equal(0n);
      expect(await token.lockedBalanceOf(alice.address)).to.equal(0n);
      await expect(core.connect(alice).refund(id)).to.be.revertedWithCustomError(core, "NothingToRefund");
    });

    it("pas de remboursement tant que la campagne est active ou réussie", async () => {
      const { core, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary, { goal: "1" });
      await core.connect(alice).contribute(id, { value: ethers.parseEther("2") });
      await expect(core.connect(alice).refund(id)).to.be.revertedWithCustomError(core, "NotRefundable");
      await time.increase(8 * DAY);
      await expect(core.connect(alice).refund(id)).to.be.revertedWithCustomError(core, "NotRefundable");
    });

    it("Canceled : le créateur peut annuler une campagne vide uniquement", async () => {
      const { core, creator, beneficiary, alice } = await deployAll();
      const a = await createCampaign(core, creator, beneficiary);
      await core.connect(creator).cancelEmptyCampaign(a);
      expect(await core.effectiveStatus(a)).to.equal(3n);
      const b = await createCampaign(core, creator, beneficiary);
      await core.connect(alice).contribute(b, { value: ethers.parseEther("1") });
      await expect(core.connect(creator).cancelEmptyCampaign(b)).to.be.revertedWithCustomError(core, "CampaignHasFunds");
      await expect(core.connect(alice).cancelEmptyCampaign(b)).to.be.revertedWithCustomError(core, "NotCreator");
    });
  });

  describe("retraits et contrôle d'accès", () => {
    it("seule la DAO (GOVERNANCE_ROLE) peut valider une tranche ou geler", async () => {
      const { core, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary, { goal: "1" });
      await core.connect(alice).contribute(id, { value: ethers.parseEther("1") });
      await expect(core.connect(alice).approveTranche(id)).to.be.reverted;
      await expect(core.connect(creator).approveTranche(id)).to.be.reverted;
      await expect(core.connect(creator).freezeCampaign(id)).to.be.reverted;
    });

    it("le bénéficiaire ne peut rien retirer sans tranche validée", async () => {
      const { core, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary, { goal: "1" });
      await core.connect(alice).contribute(id, { value: ethers.parseEther("1") });
      await time.increase(8 * DAY);
      await expect(core.connect(beneficiary).withdrawFunds(id)).to.be.revertedWithCustomError(core, "NoTrancheAvailable");
      await expect(core.connect(alice).withdrawFunds(id)).to.be.revertedWithCustomError(core, "NotBeneficiary");
    });

    it("circuit breaker : pause bloque les contributions", async () => {
      const { core, admin, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary);
      await core.connect(admin).pause();
      await expect(core.connect(alice).contribute(id, { value: ethers.parseEther("1") })).to.be.revertedWithCustomError(core, "EnforcedPause");
      await expect(core.connect(alice).pause()).to.be.reverted;
      await core.connect(admin).unpause();
      await core.connect(alice).contribute(id, { value: ethers.parseEther("1") });
    });

    it("le Core n'accepte pas d'ETH hors contribute()", async () => {
      const { core, alice } = await deployAll();
      await expect(alice.sendTransaction({ to: await core.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("sécurité : réentrance", () => {
    it("l'attaquant ne peut pas vider le contrat via refund() (nonReentrant + CEI)", async () => {
      const { core, token, creator, beneficiary, alice } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary);
      const Atk = await ethers.getContractFactory("ReentrancyAttacker");
      const atk = await Atk.deploy(await core.getAddress());

      await core.connect(alice).contribute(id, { value: ethers.parseEther("5") }); // fonds de la « victime »
      await atk.fund(id, { value: ethers.parseEther("1") });
      await time.increase(8 * DAY);

      const coreAddr = await core.getAddress();
      await atk.attack();

      // L'attaquant n'a récupéré que sa mise ; la victime est intacte.
      expect(await ethers.provider.getBalance(await atk.getAddress())).to.equal(ethers.parseEther("1"));
      expect(await ethers.provider.getBalance(coreAddr)).to.equal(ethers.parseEther("5"));
      expect(await atk.reentries()).to.be.greaterThan(0n);
      expect(await atk.lastReentryReverted()).to.equal(true);
      expect(await token.balanceOf(await atk.getAddress())).to.equal(0n);

      // La victime peut toujours se faire rembourser.
      await core.connect(alice).refund(id);
      expect(await ethers.provider.getBalance(coreAddr)).to.equal(0n);
    });
  });

  describe("arrondi des tranches (finding Slither divide-before-multiply)", () => {
    it("la somme des tranches == fonds levés, quel que soit le montant (aucun wei perdu)", async () => {
      const { core, creator, beneficiary, alice } = await deployAll();
      for (const ms of [1, 2, 3, 4, 5]) {
        const id = await createCampaign(core, creator, beneficiary, { goal: "1", milestones: ms });
        await core.connect(alice).contribute(id, { value: ethers.parseEther("1") + 7n }); // montant non divisible
        let sum = 0n;
        for (let i = 0; i < ms; i++) sum += await core.trancheAmount(id, i);
        expect(sum).to.equal(ethers.parseEther("1") + 7n);
      }
    });
  });

  describe("fuzzing léger (invariant de solvabilité)", () => {
    it("somme des remboursements == somme des contributions pour des montants aléatoires", async () => {
      const { core, creator, beneficiary, alice, bob, carol, dave } = await deployAll();
      const id = await createCampaign(core, creator, beneficiary, { goal: "1000" });
      const users = [alice, bob, carol, dave];
      let total = 0n;
      for (let i = 0; i < 20; i++) {
        const u = users[i % users.length];
        const amt = ethers.parseEther((Math.random() * 3 + 0.001).toFixed(6));
        await core.connect(u).contribute(id, { value: amt });
        total += amt;
      }
      expect(await ethers.provider.getBalance(await core.getAddress())).to.equal(total);
      await time.increase(8 * DAY);
      for (const u of users) await core.connect(u).refund(id);
      expect(await ethers.provider.getBalance(await core.getAddress())).to.equal(0n);
    });
  });
});

describe("MultiSigTreasury : seuil", () => {
  it("<= seuil : 1 signature suffit ; > seuil ou appel de contrat : 2 signatures obligatoires", async () => {
    const { treasury, o1, o2, o3, alice } = await deployAll();
    await alice.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("2") });

    // petit paiement (0.05 ETH <= 0.1) : une seule signature
    await treasury.connect(o1).submit(o3.address, ethers.parseEther("0.05"), "0x");
    expect(await treasury.neededConfirmations(0)).to.equal(1n);
    await expect(treasury.connect(o1).execute(0)).to.changeEtherBalance(o3, ethers.parseEther("0.05"));

    // gros paiement (1 ETH > 0.1) : 2 signatures
    await treasury.connect(o1).submit(o3.address, ethers.parseEther("1"), "0x");
    expect(await treasury.neededConfirmations(1)).to.equal(2n);
    await expect(treasury.connect(o1).execute(1)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");

    // même à 0 ETH, un appel de contrat (calldata) exige 2 signatures
    await treasury.connect(o1).submit(o3.address, 0n, "0x12345678");
    expect(await treasury.neededConfirmations(2)).to.equal(2n);
    await expect(treasury.connect(o1).execute(2)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");

    // une révocation retire la confirmation
    await treasury.connect(o2).confirm(1);
    await treasury.connect(o2).revoke(1);
    await expect(treasury.connect(o1).execute(1)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");
  });
});

describe("MultiSigTreasury", () => {
  it("exige 2 confirmations sur 3 pour dépenser", async () => {
    const { treasury, o1, o2, o3, alice } = await deployAll();
    await alice.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("1") });
    await treasury.connect(o1).submit(o3.address, ethers.parseEther("1"), "0x");
    await expect(treasury.connect(o1).execute(0)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");
    await treasury.connect(o2).confirm(0);
    await expect(treasury.connect(o1).execute(0)).to.changeEtherBalance(o3, ethers.parseEther("1"));
    await expect(treasury.connect(alice).submit(alice.address, 1n, "0x")).to.be.revertedWithCustomError(treasury, "NotOwner");
  });
});
