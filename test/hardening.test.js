// Durcissement : plafond journalier du multisig, pause limitée dans le temps.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployAll, time, DAY } = require("./helpers");

describe("Multisig : plafond journalier des petits envois (anti-drainage)", () => {
  it("2 envois de 0,1 ETH le même jour : le 1er avec 1 signature, le 2nd exige 2 signatures", async () => {
    const { treasury, admin, alice, o1, o2 } = await deployAll();
    await admin.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("1") });
    const v = ethers.parseEther("0.1");

    await treasury.connect(o1).submit(alice.address, v, "0x"); // tx 0
    await treasury.connect(o1).submit(alice.address, v, "0x"); // tx 1
    expect(await treasury.neededConfirmations(0)).to.equal(1n);
    await expect(treasury.connect(o1).execute(0)).to.changeEtherBalance(alice, v); // 1 signature : OK
    expect(await treasury.smallSpentOnDay(Math.floor((await time.latest()) / DAY))).to.equal(v);

    // plafond du jour atteint : le second envoi exige maintenant `required` signatures
    expect(await treasury.neededConfirmations(1)).to.equal(2n);
    await expect(treasury.connect(o1).execute(1)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");
    await treasury.connect(o2).confirm(1);
    await expect(treasury.connect(o1).execute(1)).to.changeEtherBalance(alice, v);
  });

  it("un propriétaire seul ne peut pas vider la caisse par petits virements répétés", async () => {
    const { treasury, admin, alice, o1 } = await deployAll();
    await admin.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("1") });
    const v = ethers.parseEther("0.05");
    for (let i = 0; i < 4; i++) await treasury.connect(o1).submit(alice.address, v, "0x");
    await treasury.connect(o1).execute(0);
    await treasury.connect(o1).execute(1); // 0,05 + 0,05 = 0,1 : plafond atteint
    await expect(treasury.connect(o1).execute(2)).to.be.revertedWithCustomError(treasury, "NotEnoughConfirmations");
  });

  it("le lendemain, le plafond est renouvelé", async () => {
    const { treasury, admin, alice, o1 } = await deployAll();
    await admin.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("1") });
    const v = ethers.parseEther("0.1");
    await treasury.connect(o1).submit(alice.address, v, "0x");
    await treasury.connect(o1).execute(0);
    await time.increase(DAY + 1);
    await treasury.connect(o1).submit(alice.address, v, "0x");
    await expect(treasury.connect(o1).execute(1)).to.changeEtherBalance(alice, v);
  });

  it("une transaction approuvée par 2 propriétaires ne consomme pas le plafond du jour", async () => {
    const { treasury, admin, alice, o1, o2 } = await deployAll();
    await admin.sendTransaction({ to: await treasury.getAddress(), value: ethers.parseEther("1") });
    const v = ethers.parseEther("0.1");
    await treasury.connect(o1).submit(alice.address, v, "0x");
    await treasury.connect(o2).confirm(0);
    await treasury.connect(o1).execute(0);
    expect(await treasury.smallSpentOnDay(Math.floor((await time.latest()) / DAY))).to.equal(0n);
  });
});

describe("Pause limitée dans le temps (anti-censure)", () => {
  it("n'importe qui peut lever la pause après 7 jours, pas avant", async () => {
    const { core, alice } = await deployAll();
    await core.pause();
    await expect(core.connect(alice).unpauseExpired()).to.be.revertedWith("pause active");
    await time.increase(6 * DAY);
    await expect(core.connect(alice).unpauseExpired()).to.be.revertedWith("pause active");
    await time.increase(2 * DAY); // 8 jours au total
    await core.connect(alice).unpauseExpired();
    expect(await core.paused()).to.equal(false);
  });

  it("impossible de « lever » une plateforme qui n'est pas en pause", async () => {
    const { core, alice } = await deployAll();
    await expect(core.connect(alice).unpauseExpired()).to.be.revertedWith("pause active");
  });

  it("pendant la pause les remboursements sont bloqués, puis redeviennent possibles après 7 jours", async () => {
    const { core, creator, beneficiary, alice } = await deployAll();
    await core.connect(creator).createCampaign(ethers.parseEther("50"), 3 * DAY, beneficiary.address, "Qm", 2);
    await core.connect(alice).contribute(0, { value: ethers.parseEther("1") });
    await time.increase(4 * DAY); // campagne échouée
    await core.pause();
    await expect(core.connect(alice).refund(0)).to.be.reverted;
    await time.increase(8 * DAY);
    await core.connect(alice).unpauseExpired();
    await expect(core.connect(alice).refund(0)).to.changeEtherBalance(alice, ethers.parseEther("1"));
  });
});